# Lying-DB census — 2026-05-11

Total VMs at cv>=88 (assigned): **60**
Healthy + probed: **44**
Lying-DB rate: **12/44 (27.3%)** (excluding unreachable)

## Shape distribution

| Shape | Count | % |
|---|---|---|
| HONEST | 32 | 72.7% |
| TOTAL_LIE | 6 | 13.6% |
| PARTIAL_LIE_DROPIN | 4 | 9.1% |
| PARTIAL_LIE_OTHER | 0 | 0.0% |
| SCHEMA_ZERO_LIE | 2 | 4.5% |
| UNREACHABLE | 0 | 0.0% |

## TOTAL_LIE (6 VMs)

| VM | IP | cv | tier | owner | created | T | G | P | D | A | H |
|---|---|---|---|---|---|---|---|---|---|---|---|
| instaclaw-vm-910 | 66.175.210.59 | 91 | pro | buggynear@gmail.com | 2026-05-05 | 75 | MISSING | MISSING | MISSING | active | 200 |
| instaclaw-vm-914 | 173.255.230.77 | 91 | starter | johnnyl.tasks@gmail.com | 2026-05-05 | 75 | MISSING | MISSING | MISSING | active | 200 |
| instaclaw-vm-907 | 45.33.88.52 | 91 | pro | syhranovianti@gmail.com | 2026-05-05 | 75 | PRESENT | MISSING | MISSING | active | 200 |
| instaclaw-vm-511 | 96.126.110.152 | 89 | starter | jotap6001@gmail.com | 2026-03-19 | 75 | MISSING | MISSING | MISSING | active | 200 |
| instaclaw-vm-916 | 45.33.94.197 | 91 | power | reddit6692@gmail.com | 2026-05-05 | 75 | MISSING | MISSING | MISSING | active | 200 |
| instaclaw-vm-912 | 173.255.227.194 | 91 | power | lawdalelo42@gmail.com | 2026-05-05 | 75 | MISSING | MISSING | MISSING | active | 200 |

## PARTIAL_LIE_DROPIN (4 VMs)

| VM | IP | cv | tier | owner | created | T | G | P | D | A | H |
|---|---|---|---|---|---|---|---|---|---|---|---|
| instaclaw-vm-911 | 66.175.210.93 | 91 | power | afshinieyesi@gmail.com | 2026-05-05 | 120 | PRESENT | MISSING | PRESENT | active | 200 |
| instaclaw-vm-905 | 172.104.24.133 | 91 | power | p8123117@gmail.com | 2026-05-03 | 120 | PRESENT | MISSING | PRESENT | active | 200 |
| instaclaw-vm-908 | 173.255.237.80 | 91 | starter | gong74@gmail.com | 2026-05-05 | 120 | PRESENT | MISSING | PRESENT | active | 200 |
| instaclaw-vm-512 | 96.126.110.86 | 89 | power | spillageissue@gmail.com | 2026-03-19 | 120 | PRESENT | MISSING | PRESENT | failed | 000none |

## SCHEMA_ZERO_LIE (2 VMs)

| VM | IP | cv | tier | owner | created | T | G | P | D | A | H |
|---|---|---|---|---|---|---|---|---|---|---|---|
| instaclaw-vm-895 | 198.74.59.177 | 88 | pro | launchanon01@gmail.com | 2026-04-30 | 4666 | MISSING | MISSING | MISSING | active | 200 |
| instaclaw-vm-901 | 172.104.24.64 | 89 | starter | dkatzg@gmail.com | 2026-05-03 | 4666 | MISSING | MISSING | MISSING | active | 200 |

## Honest VMs (for reference)

32 VMs passed all 6 checks. Names:

- instaclaw-vm-544 (starter, cv=91)
- instaclaw-vm-855 (power, cv=91)
- instaclaw-vm-043 (starter, cv=91)
- instaclaw-vm-860 (starter, cv=91)
- instaclaw-vm-linode-08 (starter, cv=88)
- instaclaw-vm-356 (starter, cv=89)
- instaclaw-vm-561 (pro, cv=91)
- instaclaw-vm-527 (starter, cv=91)
- instaclaw-vm-320 (pro, cv=91)
- instaclaw-vm-900 (starter, cv=89)
- instaclaw-vm-902 (starter, cv=91)
- instaclaw-vm-442 (starter, cv=88)
- instaclaw-vm-770 (starter, cv=91)
- instaclaw-vm-647 (starter, cv=88)
- instaclaw-vm-848 (starter, cv=91)
- instaclaw-vm-354 (starter, cv=91)
- instaclaw-vm-893 (pro, cv=88)
- instaclaw-vm-773 (starter, cv=91)
- instaclaw-vm-842 (starter, cv=91)
- instaclaw-vm-046 (starter, cv=91)
- instaclaw-vm-623 (starter, cv=88)
- instaclaw-vm-435 (starter, cv=88)
- instaclaw-vm-632 (pro, cv=88)
- instaclaw-vm-906 (starter, cv=91)
- instaclaw-vm-576 (pro, cv=91)
- instaclaw-vm-084 (starter, cv=88)
- instaclaw-vm-801 (starter, cv=91)
- instaclaw-vm-903 (power, cv=91)
- instaclaw-vm-317 (starter, cv=89)
- instaclaw-vm-724 (starter, cv=88)
- instaclaw-vm-327 (starter, cv=91)
- instaclaw-vm-859 (pro, cv=88)

## For consensus terminal

All non-HONEST VMs should be candidates for Phase C cohort reset (drop cv to a pre-bug version so reconciler re-processes). Specifically:

### TOTAL_LIE — recommend reset to cv=82
- `instaclaw-vm-910` (pro, buggynear@gmail.com) — TasksMax=75 (want 120); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-914` (starter, johnnyl.tasks@gmail.com) — TasksMax=75 (want 120); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-907` (pro, syhranovianti@gmail.com) — TasksMax=75 (want 120); prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-511` (starter, jotap6001@gmail.com) — TasksMax=75 (want 120); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-916` (power, reddit6692@gmail.com) — TasksMax=75 (want 120); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-912` (power, lawdalelo42@gmail.com) — TasksMax=75 (want 120); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing

### PARTIAL_LIE_DROPIN — recommend reset to cv=86
- `instaclaw-vm-911` (power, afshinieyesi@gmail.com) — prctl-subreaper pkg missing
- `instaclaw-vm-905` (power, p8123117@gmail.com) — prctl-subreaper pkg missing
- `instaclaw-vm-908` (starter, gong74@gmail.com) — prctl-subreaper pkg missing
- `instaclaw-vm-512` (power, spillageissue@gmail.com) — prctl-subreaper pkg missing; gateway active=failed health=000none

### SCHEMA_ZERO_LIE — recommend reset to cv=86
- `instaclaw-vm-895` (pro, launchanon01@gmail.com) — TasksMax=4666 (systemd default, no override.conf); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
- `instaclaw-vm-901` (starter, dkatzg@gmail.com) — TasksMax=4666 (systemd default, no override.conf); gcc missing; prctl-subreaper pkg missing; prctl-subreaper drop-in missing
