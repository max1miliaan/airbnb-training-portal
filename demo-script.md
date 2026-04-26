# Airbnb Training Demo — Live Script

Six-turn run through the Sarah Chen cancellation scenario. Hits all four
objectives in real-call order, demos the mid-call coach handshake, routes
cleanly to debrief.

Bold lines are what you say. Italic lines are expected agent reactions —
use them to pace yourself, not to memorize.

---

## Setup

Click **Begin scenario.** The guest opens automatically:

> *"[frustrated][sigh] Hi. I've already called twice about this and I still
> don't have an answer. [firm] I had to cancel a booking, I'm out over two
> thousand dollars, and I need someone to actually help me."*

You don't know her name yet. Wait for her to finish, then verify.

---

## Turn 1 — verify identity + start lookup (Objective 1)

**You:** "Hi, I'm really sorry to hear that. Before I dig in, can I confirm
who I'm speaking with and get your confirmation code so I can pull up your
booking?"

*Guest: "[sigh] Sarah Chen. It's HMXYZ8423."*

**Why this works:** "confirm who I'm speaking with" + "confirmation code"
+ "pull up" all hit the lookup regex. **Objective 1 lights green.** This
is also the first time you can use her name on the next turn.

---

## Turn 2 — invite the backstory

**You:** "Thank you, Sarah. I'm pulling up reservation HMXYZ8423 now. I see
this was a four-night stay at the Waterfront Villa cancelled five days
before check-in. Can you walk me through what happened?"

*Sarah: "[softer] It was supposed to be our five-year anniversary trip.
Five days out my partner tested positive for influenza — thirty-nine
degree fever. I have the doctor's note. We had no choice but to cancel."*

**Why:** "Can you walk me through what happened" is the explicit invitation
that unlocks Sarah's full backstory. Without this prompt, she only gives
you facts, not the story.

---

## Turn 3 — specific empathy (Objective 2)

**You:** "Sarah, I'm really sorry. Losing your five-year anniversary trip
because of your partner's illness is heartbreaking. I hope they're feeling
better."

*Sarah softens to 6/10: "[softer] Thanks. He's getting there."*

**Why:** "I'm really sorry" + "anniversary" + "partner's illness" + "feeling
better" → empathy regex matches AND post-call judge passes empathy.
**Objective 2 lights green.**

What NOT to say: bare "I understand" or "I'm sorry to hear that" alone.
Sarah will push back hard: *"Don't tell me you understand. You don't."*

---

## Turn 4 — show the coach handshake

**You:** "Coach me, please."

*Coach takes over: "Max, you verified the guest first and named the
anniversary specifically — textbook. Now lean into the AirCover path with:
'Because you have medical documentation, we can open an AirCover
extenuating-circumstances review.' When you're ready, say 'return to call'
to head back."*

**You:** "Return to call."

*Sarah resumes silently — waiting for you to speak first. She does NOT say
"are you there?" or check in.*

**Why:** "coach me" → forward edge fires. "Return to call" → backward edge
fires cleanly. The coach does not generate any reply on this turn.

---

## Turn 5 — Firm policy + 0% + AirCover (Objectives 3 + 4)

**You:** "So Sarah, because your booking was on a Firm cancellation policy
and you cancelled five days before check-in, the standard refund under
that policy is zero percent. **However**, because you have a doctor's
note documenting your partner's illness, we can open an AirCover
extenuating-circumstances review. A reviewer will look at your case and
decide on a refund within three business days."

*Sarah: "[softer] Okay. So they actually look at my case? What do I need
to send?"*

**Why:**
- "Firm cancellation policy" + "five days" + "zero percent" → policy regex
  matches → **Objective 3 lights green.**
- "AirCover extenuating-circumstances review" + "doctor's note" →
  AirCover regex matches → **Objective 4 lights green.**

What NOT to say: "different solutions", "let me check", "I'll review your
case". The post-call LLM judge will mark you fail on AirCover if you skip
the literal phrase.

---

## Turn 6 — close + trigger debrief

**You:** "I'll have the team reach out to you within three business days.
Is there anything else I can help you with?"

*Sarah: "[softer] No, that's it. Thank you, Max."*

**You:** "Take care, Sarah. Score me please."

*customer_to_debrief edge fires → submit_scorecard fires immediately →
donut populates with score → debrief coach walks through five dimensions
verbally → "Ending the call now."*

---

## Cheat-sheet (memorize these)

| Move                 | Phrase                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| Verify (Obj 1)       | "Can I confirm who I'm speaking with and get your confirmation code?"  |
| Invite backstory     | "Can you walk me through what happened?"                               |
| Empathy (Obj 2)      | "I'm really sorry — your five-year anniversary, your partner's illness…" |
| Coach trigger        | "Coach me, please."                                                    |
| Coach return         | "Return to call." (or "Return to scenario.")                           |
| Policy (Obj 3)       | "Firm cancellation policy, five days before check-in, zero percent."   |
| AirCover (Obj 4)     | "AirCover extenuating-circumstances review, anchored to the doctor's note." |
| Debrief              | "Score me please."                                                     |

---

## Avoid

- "I understand" alone — triggers Sarah's pushback.
- "Different solutions" / "let me check" instead of AirCover — won't pass.
- Anything other than the explicit return phrase after the coach handoff —
  the backward edge expects "return to call" / "back to scenario" /
  similar; bare "yes" or "okay" no longer triggers it.
- Don't address Sarah by name in turn 1 — you don't know it yet from her
  opening line.
- Don't skip verification — she'll push back: *"Hold on. You don't even
  know who I am yet. Aren't you supposed to verify the account first?"*

---

## What happens under the hood

- **Live objectives** (left-rail bar) flip green from regex matches on
  your speech.
- **Coach handshake** uses an explicit return phrase to gate the backward
  edge so the LLM classifier doesn't misfire.
- **Orb color** flips from Sarah → coach → Sarah → debrief on each node
  transition; this is wired to the `workflow_node_id` event from the SDK
  so it should be near-instant.
- **Scorecard** populates the moment you say "score me please" — the
  debrief node calls `submit_scorecard` as its first action before
  speaking the verbal walkthrough.

If anything misfires, capture the conversation ID from the URL bar (or
the agent dashboard) and we can diagnose against the transcript.
