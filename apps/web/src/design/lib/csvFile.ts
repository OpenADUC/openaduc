// SPDX-License-Identifier: BUSL-1.1
// A CSV file's bytes as text. Excel saves "CSV UTF-8" as UTF-8 and plain
// "CSV" in the Windows code page, which is Windows-1252 for Western
// European languages; a file that isn't valid UTF-8 is read as that.

/** .xlsx and .ods are zip archives; .xls is an OLE compound file. */
export function isWorkbook(bytes: Uint8Array): boolean {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  return zip || ole;
}

export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
