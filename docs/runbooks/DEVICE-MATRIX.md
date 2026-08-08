# Device matrix — the gate before cutover

Run with `EMAIL_MUTE=YES` throughout (except item 6). Claude drives; the owner
clicks and confirms what they see.

## 1. Owner's PC (baseline)

- [ ] Chrome → Pages URL → code login → dashboard appears in under 15s
- [ ] Chrome → `<prod-exec>?page=app` → login works (the emergency door)
- [ ] Install as an app (address-bar install icon) → opens standalone, correct icon
- [ ] `CreativeFlow-5.0.0.exe` → Test connection green → login → dashboard
- [ ] Pull the network mid-sync → clean error, retry recovers

## 2. THE PROBLEM PC — this line decides the cutover

Studio account, its existing access code.

- [ ] Chrome → Pages URL → login completes. **Record the seconds.**
- [ ] **Hypothesis check**: `chrome://flags/#enable-quic` → Disabled → relaunch →
      log in again. Success over forced TCP proves the paged protocol beats the
      middlebox that broke the old app. Re-enable the flag afterwards.
- [ ] `CreativeFlow-5.0.0.exe` on this PC → Test connection → login → dashboard
- [ ] Install the PWA and do one real loop: open a task, start it, upload a small file

**If anything stalls**, do not guess — follow the falsification protocol from
the old `DIAGNOSTICS.md` (kept in `D:\claude test\Main Creative Flow`), noting
*which* call stalled (ping / lite bootstrap / tasksPage N). Every v5 answer is
ping-sized, so a stall falsifies the big-response theory and points at:
WebView2 damage (reinstall the runtime), a per-process firewall block, or the
network itself (phone-hotspot probe splits PC-vs-network). Acceptable steady
state for this one PC: browser mode (`open-in-browser.txt` beside the exe) plus
the `?page=app` bookmark.

## 3. Android phone

- [ ] Chrome → Pages URL → login → ⋮ → *Add to Home screen* → opens standalone
- [ ] Daily loop: view tasks, open a review room, add a comment
- [ ] Rotate, press back, reopen from the icon — session survives

## 4. Guest link from outside

- [ ] Owner creates a comment-mode share → open the link in incognito **and** on
      mobile data → deliverable renders → guest comment posts with a name
- [ ] Revoke → the link now says invalid

## 5. Upload to the studio Drive

- [ ] Upload a small PNG → appears in the studio Drive under
      `CreativeFlow/<YYYY-MM>` → link-viewable → a Versions row exists →
      the deliverable renders back in the app

## 6. One controlled email

- [ ] `setConfig EMAIL_MUTE=NO` → `sendTestAlert` → owner receives it →
      set `EMAIL_MUTE=YES` again
- [ ] Alerts Log shows exactly one send; mail quota logged

## 7. Assigner sheet sync (new in v5)

- [ ] `createAssignerSheet` for one assigner → they open the shared link
- [ ] They add a row on **Add Tasks** → within ~10 min it appears on their
      dashboard with a Task ID written back into their row
- [ ] Mark that task Done → within ~10 min their **Completed** tab lists it
- [ ] Register their existing content-calendar sheet → *CF Requests* and
      *CF Completed* tabs appear, their own layout untouched
