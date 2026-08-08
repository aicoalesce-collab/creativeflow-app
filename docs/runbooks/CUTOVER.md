# Cutover runbook — one evening

The old system stays untouched and running the whole time. That is the rollback.

## T-3 days

- [ ] `cd tests; npx playwright test` — full battery green
- [ ] Device matrix green, **including the problem PC** (hard gate)
- [ ] OAuth origins added days ago (propagation), upload verified from the Pages origin
- [ ] **Dry run**: owner makes a Drive *copy* of the old sheet, then
      `tools\migrate.ps1 -OldSheet <copy-url> -Email <admin> -Code <code> -DryRun`
      → review the report → real run against the copy → `wipeImport`
- [ ] Freeze message drafted (below)

## Cutover evening (T0 = 20:00)

1. [ ] 19:00 — send the freeze message
2. [ ] Confirm `emailMute: true` — `tools\probe\probe.exe ping <prod-url>`
3. [ ] `tools\migrate.ps1 -OldSheet <LIVE old sheet url> -Email <admin> -Code <code>`
4. [ ] **Validation**: every `counts.*.match` true; status distribution sane;
       `overdueFormulaAlive` true (the ARRAYFORMULA columns survived the import);
       spot-check 3 tasks incl. one In Review with stage data.
       Mismatch → stop, `wipeImport` (confirm:"WIPE"), fix, re-run.
5. [ ] **Old codes work**: log in on the new app as (a) the owner, (b) the studio
       account with its existing code, (c) one consenting member with theirs.
6. [ ] `probe admin <prod> <admin> <code> '{"op":"setConfig","key":"EMAIL_MUTE","value":"NO"}'`
       then `'{"op":"sendTestAlert"}'` → owner confirms one email arrived.
7. [ ] `tools\smoke.ps1 -Url <prod-url> -ExpectV 5.0.0` — final green
8. [ ] Send the per-person rollout messages (templates below)
9. [ ] Old system: leave it running. Owner edits ONE cell on the OLD sheet —
       Config `ORG_NAME` → `⚠ MOVED — use the new CreativeFlow link` — which
       shows as a banner in every old client. Reversible in seconds; this is
       the only write ever made to the old side.

## T+1 morning and T+3 — split-brain sweep

```
probe admin <prod> <admin> <code> '{"op":"checkOldActivity","src":"<old sheet>"}'
```

- `splitBrain: false` → close the freeze.
- Otherwise: the listed tasks were created on the old system after cutover —
  re-run `migrate.ps1 -Force` (idempotent by Task ID) or re-enter the handful
  by hand, then repeat the check.

## Rollback (week 1)

Old sheet is intact → revert the ORG_NAME banner, resend the old links, done.
Anything created on v5 in the meantime:
`probe admin <prod> <admin> <code> '{"op":"newSinceCutover"}'` prints a
copy-pasteable list (deliberately no reverse migrator — a week's volume is a
handful of rows, and an untested exporter is worse than a list).

## Message templates

**Freeze (19:00, to everyone)**

> Tonight from 8pm we're moving CreativeFlow to the new version. Please don't
> add or update tasks after 8pm — anything entered after that may not carry
> over. New link tomorrow morning; **your access code stays the same**.

**Rollout (per person, next morning)**

> CreativeFlow has moved: <PAGES-URL>
> Log in with your usual email and the same 6-character code.
> · Phone: open the link in Chrome → menu ⋮ → *Add to Home screen*
> · Computer: open the link → install icon in the address bar (or use the
>   CreativeFlow app we'll send)
> · If anything ever looks stuck, this always works: <PROD-EXEC>?page=app
