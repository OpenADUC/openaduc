// SPDX-License-Identifier: BUSL-1.1
// Active Directory LDAP controls used by the deleted-objects feature.
//
// Both controls have empty value payloads — the OID alone, with criticality
// set, is enough to flip the server's behavior. ldapts's Control base class
// writes the type + criticality bytes for us; leaving writeControl as a
// no-op produces the empty-value form AD expects.
//
// References:
//   - LDAP_SERVER_SHOW_DELETED_OID (1.2.840.113556.1.4.417):
//     MS-ADTS §3.1.1.3.4.1.5. When attached to a search, AD includes
//     entries with isDeleted=TRUE in the result. When attached to a
//     modify of a deleted entry, AD treats it as a tombstone reanimation
//     primitive.
//   - LDAP_SERVER_SHOW_RECYCLED_OID (1.2.840.113556.1.4.2064):
//     MS-ADTS §3.1.1.3.4.1.16. Required to also see entries that have
//     transitioned past the deleted-object lifetime into the recycled
//     state (Recycle Bin only). Recycled entries cannot be restored.

import { Control } from 'ldapts';

const SHOW_DELETED_OID = '1.2.840.113556.1.4.417';
const SHOW_RECYCLED_OID = '1.2.840.113556.1.4.2064';

export class ShowDeletedControl extends Control {
  constructor() {
    super(SHOW_DELETED_OID, { critical: true });
  }
}

export class ShowRecycledControl extends Control {
  constructor() {
    super(SHOW_RECYCLED_OID, { critical: true });
  }
}

/** Both controls together — the standard set for any deleted-object op. */
export function deletedObjectControls(): Control[] {
  return [new ShowDeletedControl(), new ShowRecycledControl()];
}
