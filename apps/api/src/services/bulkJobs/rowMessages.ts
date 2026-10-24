// SPDX-License-Identifier: BUSL-1.1

/** What a failed row says to the operator. */
export function failureMessage(code: string, detail: string | null): string {
  const reason = detail ? `: ${detail}` : '';
  switch (code) {
    case 'not_found':
      return 'No such user in the directory.';
    case 'permission_denied':
      return `The directory refused the change${reason}`;
    case 'directory_unavailable':
      return 'No domain controller could be reached.';
    case 'interrupted':
      return 'OpenADUC stopped while changing this account. Check it, then retry.';
    default:
      return `The change failed${reason}`;
  }
}
