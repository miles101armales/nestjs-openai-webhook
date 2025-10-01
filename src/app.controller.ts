import { Controller, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly app: AppService) {}

  @Post('leadtech')
  async leadtech(@Body() dto: { user_id: string; text: string }) {
    const response = await this.app.bufferAndReturn(dto.user_id, dto.text); // <— ждём до конца
    return { status: 'ok', response };
  }
}
