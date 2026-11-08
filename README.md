# site-text-bot

Text a change to a phone number; the bot edits [new-smyles](https://github.com/enriquezm/new-smyles), sends a preview link, and deploys when you reply "ship it".

Design doc: [Portfolio Text Bot — Design Doc](https://claude.ai/artifact/JmbCV3h8wuqXPadiBrrCPW)

## How a request goes

```
you: update the headline to say Design engineer building with AI
bot: On it.
bot: Changing the hero headline to 'Design engineer building with AI'. Okay? (yes / no)
you: yes
bot: Making the change now. I'll text you a preview link.
bot: Preview: https://new-smyles-pr-14.onrender.com
     Reply "ship it" to deploy, or "cancel".
you: ship it
bot: Shipped. Render is deploying it to production now. Text "undo" to revert.
```

Commands anytime: `ship it`, `cancel`, `undo`, `status`, `help`.

- Nothing is written until you say yes to the plan; nothing reaches production until you say "ship it".
- Vague requests get a clarifying question first.
- After an edit the bot runs `npm run lint`, `npm run typecheck` and `npm run build`. If they fail, Claude Code gets one retry; if they still fail you get a short error and the change is dropped.
- `cancel` drops the pending change and closes its PR. `undo` reverts the last shipped change (after you confirm).
- Threads expire after an hour without activity.
- Numbers not on the allowlist are ignored silently; every webhook's Twilio signature is checked.

## Layout

| File | What it does |
| --- | --- |
| `src/server.ts` | `POST /sms` webhook: signature check, allowlist, immediate TwiML reply |
| `src/conversation.ts` | Pure state machine: one text in → reply, new thread state, jobs to run |
| `src/worker.ts` | Background jobs: plan, implement, ship, undo, close PR |
| `src/queue.ts` | In-process queue, one job at a time, recorded in Postgres |
| `src/claude.ts` | Claude Code via the Agent SDK: read-only planner (structured output) and implementer |
| `src/workspace.ts` | Fresh clone per job, site checks, commit/push/revert |
| `src/github.ts` | PRs, merges, and finding the Render preview URL |
| `src/store.ts` | Postgres tables: `allowlist`, `threads`, `jobs`, `shipped` |

## Setup

1. **Site on Render with PR previews.** The site needs to be a Render static site (build `npm run generate`, publish `.output/public`) with **Pull Request Previews** turned on, so each bot PR gets a preview URL. The bot finds it from the GitHub deployment or Render's PR comment.
2. **Twilio.** Buy a number. You'll point its "A message comes in" webhook at `https://<bot>.onrender.com/sms` (HTTP POST) after step 4.
3. **GitHub token.** Fine-grained personal access token limited to `enriquezm/new-smyles` with **Contents** and **Pull requests** read/write.
4. **Deploy the bot.** In Render: New → Blueprint → this repo. Fill in the secrets `render.yaml` asks for (`PUBLIC_URL`, Twilio keys, `OWNER_PHONE`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`). `OWNER_PHONE` seeds the allowlist with you as owner.
5. Set the Twilio webhook, text the number `help`.

Adding someone later:

```sql
insert into allowlist (phone, name, role) values ('+1702...', 'Name', 'requester');
```

Requesters can ask for changes and see previews; only the owner can ship or undo.

## Develop

```sh
npm install
npm test          # state machine, webhook security, full text flow with fakes
npm run typecheck
cp .env.example .env && npm run dev
```

Locally, `SKIP_TWILIO_SIGNATURE=true` lets you post to the webhook with curl:

```sh
curl -d From=+1702... --data-urlencode "Body=update the headline to say Hi" localhost:3000/sms
```
