# Development Samba AD domain controller

A throwaway Samba 4 AD DC (domain `OPENADUC.TEST`) with known fixtures, for running OpenADUC locally and for integration tests. Development only: the passwords below are public, and the ports bind to `127.0.0.1`.

```bash
pnpm dc:up      # build, start, wait until healthy, seed (about 15 s from scratch)
pnpm dc:seed    # re-apply fixtures: recreates missing objects, re-locks/disables/expires
pnpm dc:status
pnpm dc:down    # stop and delete the domain (volume and generated CA)
```

## Connecting

| Setting        | Value                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| LDAPS          | `ldaps://localhost:10636` (override with `DC_LDAPS_PORT`)                               |
| StartTLS       | `ldap://localhost:10389` (override with `DC_LDAP_PORT`)                                 |
| CA certificate | `dev/samba-dc/.generated/ca.pem`, written on start; set `AD_TLS_CA_PATH` to it          |
| Base DN        | `DC=openaduc,DC=test`                                                                   |
| Domain         | `openaduc.test`                                                                         |
| Dead DC URL    | `ldaps://localhost:10637` (nothing listens there; put it first to exercise DC failover) |

The server certificate covers `localhost`, `127.0.0.1` and `dc1.openaduc.test`, so `AD_TLS_REJECT_UNAUTHORIZED=1` works with the CA above. Samba refuses simple binds over unencrypted LDAP ("Transport encryption required"), as a hardened AD does.

## Fixtures

Every fixture account's password is `OpenADUC-dev-User1`. The built-in `Administrator` password is `OpenADUC-dev-Admin1`. Fixtures live under `OU=OpenADUC Test,DC=openaduc,DC=test`.

| Account        | Where            | State                                    | Groups                         |
| -------------- | ---------------- | ---------------------------------------- | ------------------------------ |
| `oa.admin`     | Staff            | enabled                                  | OpenADUC Admins, Domain Admins |
| `oa.operator`  | Staff            | enabled                                  | OpenADUC Operators             |
| `oa.auditor`   | Staff            | enabled                                  | OpenADUC Auditors              |
| `svc-openaduc` | Service Accounts | enabled; use as the sync service account | (none)                         |
| `alice.anders` | Staff            | enabled                                  | Engineering                    |
| `bob.baker`    | Staff            | enabled                                  | Engineering                    |
| `carol.chen`   | Contractors      | **disabled**                             | (none)                         |
| `dave.diaz`    | Staff            | **locked out** (5 bad passwords)         | All Staff                      |
| `erin.evans`   | Staff            | **must change password at next logon**   | All Staff                      |
| `WS01`, `WS02` | Workstations     | computers; WS01 enabled, WS02 disabled   |                                |

Groups live in `OU=Groups`. `Engineering` is nested inside `All Staff`. Domain policy: lockout after 5 bad passwords, until an administrator unlocks (duration 0).

`OpenADUC Operators` has inherited full control over `OU=OpenADUC Test`, so `oa.operator` can unlock, reset, disable, edit and move fixture users. `oa.auditor` has no write rights in AD. `oa.admin` is a Domain Admin.

`pnpm dc:seed` puts stateful fixtures back: Dave is locked again, Carol disabled, Erin's password expired, and every other fixture account unlocked (wrong-password tests would otherwise lock them for good). Objects you create are left alone; `pnpm dc:down && pnpm dc:up` gives a pristine domain.

## Using it with the app

In the setup wizard: LDAP URL `ldaps://localhost:10636`, base DN `DC=openaduc,DC=test`, admin `oa.admin`, then service account `svc-openaduc`. Setup maps the admin role to Domain Admins.

Then map the other two roles in **Configuration → Roles**: Operator → `OpenADUC Operators`, Auditor → `OpenADUC Auditors`. They apply at each operator's next sign-in.

## How it works

`Dockerfile` installs Debian's Samba AD DC packages. On first start `entrypoint.sh` provisions the domain into the `samba-data` volume, generates a CA and server certificate, and points Samba at them; later starts reuse the volume. `seed.sh` runs inside the container with `samba-tool` and `ldbmodify`, and checks each object before creating it. No privileged mode is needed: NT ACLs are stored in `user.*` extended attributes.
