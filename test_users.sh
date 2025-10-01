#!/usr/bin/env bash
set -e
URL=${1:-http://localhost:3000/leadtech}
hdr='Content-Type: application/json'

# U1: три сообщения в одном окне
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U1","text":"хочу"}' &
sleep 1
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U1","text":"песню"}' &
sleep 1
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U1","text":"маме"}' &

# U2: два окна (перерыв > 10с)
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U2","text":"хочу песню папе"}' &
sleep 12
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U2","text":"на юбилей"}' &

# U3: параллельно с U1
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U3","text":"как я могу"}' &
sleep 2
curl -s -X POST $URL -H "$hdr" -d '{"user_id":"U3","text":"купить у вас песню"}' &

wait
echo -e "\nDone."