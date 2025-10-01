import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type BufState = {
  msgs: string[];
  timer?: NodeJS.Timeout;
  processing: boolean;
  waiter?: {
    promise: Promise<string>;
    resolve: (v: string) => void;
    reject: (e: any) => void;
  };
};

@Injectable()
export class AppService {
  private readonly log = new Logger(AppService.name);
  private readonly OA = 'https://api.openai.com/v1';
  private readonly key = process.env.OPENAI_API_KEY || '';

  private buf = new Map<string, BufState>(); // на пользователя — один буфер и один waiter

  constructor(private readonly http: HttpService) {}

  // mini-HTTP JSON
  private async j<T = any>(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: any,
  ): Promise<T> {
    const started = Date.now();
    this.log.debug(`HTTP ${method} ${url}`);
    const r$ = this.http.request<T>({
      url,
      method,
      data: body ?? undefined,
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2', // <-- обязательный заголовок
      },
      timeout: 60_000,
    });
    try {
      const r = await firstValueFrom(r$);
      this.log.debug(`HTTP ${method} ${url} OK in ${Date.now() - started}ms`);
      return r.data;
    } catch (e: any) {
      this.log.error(
        `HTTP ${method} ${url} FAIL in ${Date.now() - started}ms: ${e?.message || e}`,
      );
      throw e;
    }
  }

  // запрос к Assistants (статусы опрашиваем каждые 10с)
  private async askOpenAI(text: string): Promise<string> {
    this.log.log(`OpenAI: start for text="${text}"`);
    const assistants = await this.j<{ data: { id: string }[] }>(
      `${this.OA}/assistants`,
    );
    const assistant_id = assistants?.data?.[0]?.id;
    if (!assistant_id) throw new Error('No assistants found');

    const thread = await this.j<{ id: string }>(
      `${this.OA}/threads`,
      'POST',
      {},
    );
    const thread_id = thread.id;

    await this.j(`${this.OA}/threads/${thread_id}/messages`, 'POST', {
      role: 'user',
      content: text,
    });

    const run = await this.j<{ id: string; status: string }>(
      `${this.OA}/threads/${thread_id}/runs`,
      'POST',
      { assistant_id },
    );
    const run_id = run.id;

    let status = run.status,
      tries = 0;
    this.log.log(`OpenAI: polling run=${run_id} thread=${thread_id}`);
    while (!['completed', 'failed', 'cancelled', 'expired'].includes(status)) {
      await new Promise((r) => setTimeout(r, 10_000));
      const rr = await this.j<{ status: string }>(
        `${this.OA}/threads/${thread_id}/runs/${run_id}`,
      );
      status = rr.status;
      this.log.debug(`OpenAI: status=${status}, try=${tries}`);
      if (++tries > 180) throw new Error('Timeout waiting for run');
    }
    if (status !== 'completed')
      throw new Error(`Run ended with status: ${status}`);

    const msgs = await this.j<{ data: any[] }>(
      `${this.OA}/threads/${thread_id}/messages`,
    );
    const first = msgs?.data?.[0];
    const parts = (first?.content || [])
      .map((c: any) => c?.text?.value)
      .filter(Boolean);
    const answer = parts.join('\n').trim() || '(пустой ответ)';
    this.log.log(`OpenAI: completed, answer length=${answer.length}`);
    return answer;
  }

  // === Главная функция: копим 10с и возвращаем итог сразу клиенту ===
  async bufferAndReturn(userId: string, text: string): Promise<string> {
    if (!userId || !text) throw new Error('user_id и text обязательны');

    // получаем или создаём буфер
    let b = this.buf.get(userId);
    if (!b) {
      b = { msgs: [], processing: false };
      this.buf.set(userId, b);
      this.log.debug(`BUF: new bucket for ${userId}`);
    }

    // пушим сообщение в окно
    const msg = String(text).trim();
    b.msgs.push(msg);
    this.log.log(`BUF: push "${msg}" (count=${b.msgs.length}) for ${userId}`);

    // если уже есть waiter — просто ждём его
    if (b.waiter) {
      this.log.debug(`BUF: attach to existing waiter for ${userId}`);
      return b.waiter.promise;
    }

    // создаём общий waiter для всех запросов в это окно
    b.waiter = (() => {
      let resolve!: (v: string) => void, reject!: (e: any) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    })();

    // стартуем 10-сек буферизацию, потом один раз запускаем OpenAI
    b.timer = setTimeout(async () => {
      const joined = b!.msgs.join(' ').replace(/\s+/g, ' ').trim();
      this.log.log(`BUF: window closed for ${userId}, joined="${joined}"`);
      b!.processing = true;

      try {
        const answer = await this.askOpenAI(joined);
        this.log.log(`BUF: resolve for ${userId}`);
        b!.waiter!.resolve(answer);
      } catch (e: any) {
        this.log.error(`ERR: ${userId} -> ${e?.message || e}`);
        b!.waiter!.reject(new Error(`Ошибка: ${e?.message || e}`));
      } finally {
        this.buf.delete(userId);
        this.log.debug(`BUF: cleared for ${userId}`);
      }
    }, 10_000);

    // Возвращаем промис — контроллер подождёт и отдаст финал
    return b.waiter.promise;
  }
}
