# Step-up happens on first write, not through an edit mode

Writes need a step-up, which re-binds to AD with the operator's password and opens an elevated session. We used to present that as a visible "edit mode": a toggle to enter it, a countdown that pulsed near expiry, and a fixed lifetime. Writes already prompted for step-up on demand, so the mode mostly added a step and a ticking clock. We dropped it.

Write-capable operators always see editable fields and actions. The first write prompts step-up and then retries. The elevated session ends after an idle timeout (15 minutes by default) and is capped at an absolute lifetime (4 hours by default), both configurable. The UI shows elevation quietly and offers to end it early.

## Considered options

- **Keep edit mode as it was.** Explicit, but adds friction and anxiety. Fixed expiry also interrupted operators mid-task.
- **Keep edit mode with a sliding lifetime.** Fixes the interruptions but keeps a mode operators have to manage.

## Consequences

The operator's AD password stays cached in memory for as long as the elevated session lives. The idle timeout limits how long an unattended browser keeps write access; the absolute cap limits how long the password can stay cached however busy the operator is. Requests the SPA makes by itself, such as polling a running sync task, don't count as activity: otherwise an unattended browser left on a polling page would stay elevated until the absolute cap.
