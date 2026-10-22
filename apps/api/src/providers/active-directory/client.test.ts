// SPDX-License-Identifier: BUSL-1.1
import {
  BusyError,
  InvalidCredentialsError,
  InsufficientAccessError,
  UnavailableError,
} from 'ldapts';
import { describe, expect, it } from 'vitest';
import { isDirectoryUnreachable } from './client.js';

const sysErr = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:636`), { code });

describe('isDirectoryUnreachable', () => {
  it('is true for failures to reach or talk to the server', () => {
    for (const err of [
      sysErr('ECONNREFUSED'),
      sysErr('ETIMEDOUT'),
      sysErr('EHOSTUNREACH'),
      sysErr('ENOTFOUND'),
      sysErr('ECONNRESET'),
      sysErr('DEPTH_ZERO_SELF_SIGNED_CERT'),
      sysErr('ERR_TLS_CERT_ALTNAME_INVALID'),
      new AggregateError([sysErr('ECONNREFUSED'), sysErr('ECONNREFUSED')]),
      new Error('Connection timeout'),
      new Error('SearchRequest: Operation timed out'),
      new Error(
        'Connection closed before message response was received. Message type: BindRequest (0x60)',
      ),
      new BusyError('busy'),
      new UnavailableError('unavailable'),
    ]) {
      expect({ err: String(err), unreachable: isDirectoryUnreachable(err) }).toEqual({
        err: String(err),
        unreachable: true,
      });
    }
  });

  it('is false for answers from the server and for bugs in our own code', () => {
    for (const err of [
      new InvalidCredentialsError('bad password'),
      new InsufficientAccessError('no'),
      new TypeError("Cannot read properties of undefined (reading 'dn')"),
      new Error('Invalid search filter type: 0x99'),
      'a string',
    ]) {
      expect({ err: String(err), unreachable: isDirectoryUnreachable(err) }).toEqual({
        err: String(err),
        unreachable: false,
      });
    }
  });
});
