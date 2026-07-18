# Intimacy Level — Product Rules (v1)

**Status:** Draft for engineering  
**Scope:** Backend + API fields for mobile UI  
**Out of scope for v1:** Icebreakers / “getting to know you” games (planned later), decay, global intimacy across characters, hard content gates by level

---

## 1. Product definition

### What it is
Per match (one user ↔ one character conversation), Clove tracks an **intimacy level** that represents how close the relationship feels.

### What the user sees
- **Level number:** `1`–`5`
- **Progress bar:** progress within the current level (`0`–`100`)
- Optional toast when they level up (e.g. “You’re getting closer”)
- Stage *names* are optional for UI later; not required in v1

### Internal stage names (for prompts / analytics only)

| Level | Name | Soft vibe |
|------:|------|-----------|
| 1 | Matched | Curious, light |
| 2 | Curious | Friendly, small shares |
| 3 | Warm | Warm, soft flirt if user flirts |
| 4 | Close | More vulnerable, stronger affection OK |
| 5 | Intimate | Deep attachment tone; still match user energy |

### Hard rules
- **Per conversation only** (unique `userId` + `characterId`)
- **No decay** in v1
- **No level-down** in v1
- Levels **soft-guide character tone only** (prompt injection). They do **not** hard-block flirt, spicy chat, or photos. Safety remains the existing 18+ + image gates.
- Exact point formula is **not** shown in the UI

---

## 2. Core state

Stored on each `Conversation`:

| Field | Type | Meaning |
|-------|------|---------|
| `intimacyLevel` | int `1`–`5` | Current level |
| `intimacyScore` | int `0`–`100` | Progress inside current level |

Derived for clients:

| Field | Meaning |
|-------|---------|
| `intimacyProgress` | `intimacyScore / 100` (0.0–1.0) |
| `leveledUp` | `true` on the response that caused a level-up |

Analytics-only (do not expose as primary UX):

```text
lifetimePoints = (intimacyLevel - 1) * 100 + intimacyScore
```

### Defaults
- New conversation: `intimacyLevel = 1`, `intimacyScore = 0`

---

## 3. Level-up rules

```text
When intimacyScore would exceed or equal 100 and intimacyLevel < 5:
  intimacyLevel += 1
  intimacyScore = 10

When intimacyLevel == 5:
  intimacyScore is capped at 100 (no further level)
```

- Overflow above 100 on a level-up turn does **not** carry beyond the reset to `10` (simple v1).
- Multiple level-ups in one event are **not** allowed; apply at most one level-up per scoring event. Remaining overflow after reset is discarded in v1.

---

## 4. Pace target

**Goal:** An engaged user can reach **level 5 in about 2 calendar days** of real use.

Rough expectation:

| Transition | Typical timing |
|------------|----------------|
| 1 → 2 | First session / day 1 |
| 2 → 3 | Later day 1 or morning day 2 |
| 3 → 4 | Day 2 |
| 4 → 5 | Day 2 evening |

Lighter users may take 3–4 days. That is fine.

To make this possible **without icebreakers**, chat + proactive replies + photo moments carry the economy (see §6–§7).

---

## 5. Scoring principles

1. **Event-sourced deltas** — discrete events add points; no full recompute from message history each time.
2. **Reward mutual investment**, not spam.
3. **Idempotent events** — the same logical event must not double-credit (key by conversation + event type + source id).
4. **Daily caps** — prevent grinding a level in minutes.
5. **Assistant-only traffic never scores** — only user actions and completed shared moments (photo ready after user ask, user reply to proactive).
6. **No penalties** in v1 (ignored messages = 0, not negative).

---

## 6. Daily caps

All caps are **per conversation per UTC calendar day** unless noted.

Rebalanced for the two-day level-5 target (~370 points needed across four level-ups).

| Cap | Limit | Purpose |
|-----|------:|---------|
| **Total daily gain** | **+200** | ~two levels/day when engaged; ~two days to 5 |
| Chat bucket | +100 | Continuous messaging |
| Question-answer events | 4 / day | Answering character questions |
| Shared-day bonus | 1 / day | Both sides active same day |
| Proactive-reply events | 2 / day | Aligns with proactive daily cap |
| Photo moments | 3 / day | Shared photo beats |
| Memory warmth bonus | +20 / day | Periodic LLM assist |

If a delta would exceed the total daily gain cap, grant only the remaining room (partial credit OK).

---

## 7. Point table (v1 — no icebreakers)

### 7.1 Chat signals

Apply when a **user** message is persisted.

| Event ID | When it fires | Points | Extra rules |
|----------|---------------|-------:|-------------|
| `user_message` | User message after filler filter | **+3** | Counts toward chat bucket |
| `user_message_meaningful` | Same message, but “meaningful” | **+5** instead of +3 | Mutually exclusive with `user_message` |
| `answered_question` | User message and previous assistant message contained `?` | **+8** | Max 4/day; stacks with message points |
| `shared_day` | First time today that both user and assistant have messaged on this calendar day | **+10** | Once/day |

**Meaningful message** (any one is enough):
- ≥ 8 whitespace-separated words, or
- contains `?`, or
- length ≥ 40 characters after trim

**Filler (0 points, no events):**
- After trim, length &lt; 2
- Matches filler set (case-insensitive): `ok`, `k`, `kk`, `lol`, `lmao`, `haha`, `hahaha`, `yes`, `no`, `nah`, `yep`, `yeah`, `sup`, `hi`, `hey`, `hello`, `bye`, `gn`, `gm`, `ty`, `thanks`, `np`, plus single-emoji-only messages

### 7.2 Proactive signals

| Event ID | When it fires | Points | Extra rules |
|----------|---------------|-------:|-------------|
| `proactive_sent` | Character sends proactive message | **0** | Never awards points |
| `proactive_reply` | User sends a message within **2 hours** of the latest proactive assistant message in this conversation | **+15** | Max 2/day; idempotent per proactive message id |

Ignored proactive messages: **0** (existing backoff handles product behavior).

### 7.3 Photo signals

| Event ID | When it fires | Points | Extra rules |
|----------|---------------|-------:|-------------|
| `photo_moment_cache` | Assistant message gets a ready image via cache hit | **+12** | Max 3 photo moments/day combined |
| `photo_moment_generated` | Image request moves to `ready` with a newly generated asset | **+16** | Same daily photo-moment cap; not stacked with cache event for the same message |
| `photo_request_accepted` | Image plan accepted in chat (cache or queued generate) | **+4** | Once per user message / image request; small intent bonus |

Rejected / failed / quota-exceeded image paths: **0**.

### 7.4 Memory / warmth assist (periodic)

On existing conversation memory refresh (about every 4 messages):

Ask the model for coarse scores only:

```json
{ "warmth": 0, "disclosure": 0, "reciprocity": 0 }
```

Each field is an integer `0`–`3`.

| Event ID | Points | Extra rules |
|----------|-------:|-------------|
| `memory_warmth` | `warmth + disclosure + reciprocity` (max **+9** per refresh) | Also limited by memory daily cap **+20/day** |

Malformed model output → **0** (no penalty).

---

## 8. Soft prompt coupling

On every character reply, inject a short system instruction from `intimacyLevel`:

| Level | Instruction intent |
|------:|--------------------|
| 1 | Keep it light and curious. Don’t overshare backstory. |
| 2 | Be friendly. Share small day-to-day details. Ask simple questions. |
| 3 | Be warmer. Soft flirt only if they flirt. Use callbacks. |
| 4 | Closer and more open. Stronger affection OK. Still match their energy. |
| 5 | Intimate attached tone is OK. Stay in character. Never narrate the meter. |

Characters must **never** mention points, levels, or “intimacy score” unless the user explicitly asks about a progress UI the product shows.

---

## 9. API contract (minimum)

Expose on:
- `GET /conversations`
- `GET /conversations/:id/messages` (optional; at least conversation payload)
- `POST /conversations/:id/messages` JSON response and SSE `done` event

```json
{
  "intimacyLevel": 3,
  "intimacyScore": 42,
  "intimacyProgress": 0.42,
  "leveledUp": false
}
```

Conversation list items should include `intimacyLevel` and `intimacyScore` (or `intimacyProgress`) so the UI can show a chip/bar without opening the thread.

---

## 10. Idempotency & bookkeeping

Maintain a small append-only (or unique-constrained) event record, e.g. `IntimacyEvent`:

| Field | Purpose |
|-------|---------|
| `conversationId` | Scope |
| `eventType` | From §7 |
| `sourceId` | Message id, image request id, etc. |
| `points` | Granted after caps |
| `createdAt` | Day-cap windows |

Unique on `(conversationId, eventType, sourceId)` so retries are safe.

Scoring must run in the same places events naturally occur:
- user message persist
- proactive send (no-op points) / user message after proactive
- image cache attach / image worker ready
- memory refresh

---

## 11. Anti-abuse summary

- Filler messages = 0  
- Daily total cap +200  
- Bucket caps in §6  
- Idempotent source ids  
- No points for assistant-only or proactive send  
- No points for failed/rejected photo asks  
- At most one level-up per scoring event  

---

## 12. Explicitly deferred

| Item | When |
|------|------|
| Icebreaker / questionnaire games | v1.1+ (will add medium point events) |
| Decay after long silence | Later, if needed |
| Hard gates (block spicy/photos by level) | Not planned; soft tone only |
| Stage names in mobile UI | Optional polish |
| Spending / gifting intimacy points | Out of scope |

---

## 13. Acceptance examples

### Happy day-1 path (approx.)
- 12 meaningful user messages → chat points  
- 3 answered questions  
- shared-day bonus  
- 1 proactive reply within 2h  
- 1 memory warmth refresh  
→ Should approach or complete **level 2**, not finish the whole ladder.

### Happy day-2 path (approx.)
- Continued chat under daily caps  
- Another proactive reply  
- 1–2 photo moments  
- Memory bonuses  
→ Should be able to reach **level 5** if day 1 was engaged.

### Spam path
- 50× `lol` / `k` → **0** progress  
- 50 short real messages same day → hard-stopped by chat + total daily caps  

---

## 14. Open engineering notes (non-product)

- Use UTC for “calendar day” caps for simplicity in v1.  
- Partial credit when hitting the daily total cap is OK.  
- Feature can ship behind a flag if desired; product default is **on** once implemented (unlike image replies).  
- Icebreakers, when added, should plug into the same event + cap system without redesigning levels.
