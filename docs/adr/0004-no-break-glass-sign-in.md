# Active Directory is the only way in

OpenADUC signs every operator in with a live bind to Active Directory and holds no credentials of its own to sign in with. We considered a local "recovery account", created in the setup wizard, for when every domain controller is unreachable or nobody is left in the admin group. We won't build it. With every DC down there is nothing OpenADUC could administer anyway, and a lost admin group is fixed in AD or in one database setting by whoever runs the server. A local password store would be new attack surface on a tool that otherwise holds no sign-in secrets, and a credential that's rarely used is rarely rotated and easily forgotten.

## Considered options

- **A local recovery account**, hashed with scrypt, limited to configuration capabilities, every use audited and surfaced. Rejected for the reasons above.

## Consequences

If every DC is unreachable, or no one is left in a role group, nobody can sign in until that's fixed. [Recovering admin access](../security.md#recovering-admin-access) describes the fix for a lost admin group: put someone back in the group in AD, or point the `authz.admin_group_dn` setting at a group that has members.
