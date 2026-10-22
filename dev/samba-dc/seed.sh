#!/bin/sh
# Seed the dev domain with OpenADUC's test fixtures. Safe to re-run: every
# object is created only if missing, and stateful fixtures (disabled,
# locked, must-change) are put back into that state, so tests can reset the
# directory by running this again (`pnpm dc:seed`).
set -eu

BASE="DC=openaduc,DC=test"
ROOT="OU=OpenADUC Test"
UPN_SUFFIX="openaduc.test"
PASSWORD="${DC_FIXTURE_PASSWORD:-OpenADUC-dev-User1}"
SAM=/var/lib/samba/private/sam.ldb
export LDAPTLS_CACERT=/var/lib/samba/private/tls/openaduc/ca.pem

exists() { ldbsearch -H "$SAM" -b "$1" -s base dn 2>/dev/null | grep -q '^dn:'; }

ou() { # ou "OU=Staff,OU=OpenADUC Test"
  exists "$1,$BASE" || samba-tool ou create "$1" >/dev/null
}

group() { # group <name> <ou>
  samba-tool group show "$1" >/dev/null 2>&1 \
    || samba-tool group add "$1" --groupou="$2" >/dev/null
}

member() { # member <group> <member>
  samba-tool group listmembers "$1" | grep -qix "$2" \
    || samba-tool group addmembers "$1" "$2" >/dev/null
}

user() { # user <sam> <given> <surname> <ou> [extra samba-tool args…]
  sam=$1 given=$2 surname=$3 userou=$4
  shift 4
  samba-tool user show "$sam" >/dev/null 2>&1 && return 0
  samba-tool user create "$sam" "$PASSWORD" \
    --given-name="$given" --surname="$surname" \
    --userou="$userou" --mail-address="$sam@$UPN_SUFFIX" "$@" >/dev/null
}

computer() { # computer <name> <ou>
  samba-tool computer show "$1" >/dev/null 2>&1 \
    || samba-tool computer create "$1" --computerou="$2" >/dev/null
}

# --- Domain policy: lockout after 5 bad passwords, until an admin unlocks.
samba-tool domain passwordsettings set \
  --account-lockout-threshold=5 --account-lockout-duration=0 \
  --reset-account-lockout-after=30 >/dev/null

# --- OUs
ou "$ROOT"
for child in Staff Contractors "Service Accounts" Workstations Groups; do
  ou "OU=$child,$ROOT"
done

# --- Role and directory groups
GROUPS_OU="OU=Groups,$ROOT"
for g in "OpenADUC Admins" "OpenADUC Operators" "OpenADUC Auditors" Engineering "All Staff"; do
  group "$g" "$GROUPS_OU"
done
member "All Staff" Engineering # nested group

# --- Operators (one per OpenADUC role) and the sync service account
user oa.admin OpenADUC Admin "OU=Staff,$ROOT" --job-title="Directory Admin"
user oa.operator OpenADUC Operator "OU=Staff,$ROOT" --job-title="Helpdesk"
user oa.auditor OpenADUC Auditor "OU=Staff,$ROOT" --job-title="Auditor"
user svc-openaduc Sync Service "OU=Service Accounts,$ROOT" --description="OpenADUC sync service account"
member "OpenADUC Admins" oa.admin
member "Domain Admins" oa.admin # setup's default admin group, and full write rights
member "OpenADUC Operators" oa.operator
member "OpenADUC Auditors" oa.auditor

# Operators may manage everything under the fixture OU (inherited full
# control). Real deployments delegate narrower rights; this keeps dev simple.
OPS_SID=$(samba-tool group show "OpenADUC Operators" --attributes=objectSid | sed -n 's/^objectSid: //p')
samba-tool dsacl get --objectdn="$ROOT,$BASE" | grep -q "$OPS_SID" \
  || samba-tool dsacl set --objectdn="$ROOT,$BASE" --sddl="(A;CI;GA;;;$OPS_SID)" >/dev/null

# --- Ordinary people
user alice.anders Alice Anders "OU=Staff,$ROOT" --department=Engineering --job-title="Engineer"
user bob.baker Bob Baker "OU=Staff,$ROOT" --department=Engineering --job-title="Senior Engineer"
user carol.chen Carol Chen "OU=Contractors,$ROOT" --department=Contractors --job-title="Contractor"
user dave.diaz Dave Diaz "OU=Staff,$ROOT" --department=Sales --job-title="Account Manager"
user erin.evans Erin Evans "OU=Staff,$ROOT" --department=Sales --job-title="Sales Associate"
member Engineering alice.anders
member Engineering bob.baker
member "All Staff" dave.diaz
member "All Staff" erin.evans

# Stateful fixtures: restored on every run.
samba-tool user disable carol.chen >/dev/null

ldbmodify -H "$SAM" >/dev/null <<EOF
dn: CN=Erin Evans,OU=Staff,$ROOT,$BASE
changetype: modify
replace: pwdLastSet
pwdLastSet: 0
EOF

# Lock Dave out the way a real user gets locked: bad password binds.
locked() {
  ldbsearch -H "$SAM" -b "CN=Dave Diaz,OU=Staff,$ROOT,$BASE" -s base lockoutTime \
    | sed -n 's/^lockoutTime: //p' | grep -qv '^0$'
}
i=0
while ! locked && [ $i -lt 10 ]; do
  ldapwhoami -H ldaps://localhost -x -D "dave.diaz@$UPN_SUFFIX" -w wrong-password >/dev/null 2>&1 || true
  i=$((i + 1))
done
locked || { echo "seed: failed to lock out dave.diaz" >&2; exit 1; }

# --- Computers
computer WS01 "OU=Workstations,$ROOT"
computer WS02 "OU=Workstations,$ROOT"
# samba-tool creates computers disabled; WS01 is the enabled one.
ldbmodify -H "$SAM" >/dev/null <<EOF
dn: CN=WS01,OU=Workstations,$ROOT,$BASE
changetype: modify
replace: userAccountControl
userAccountControl: 4096
EOF

echo "seeded"
