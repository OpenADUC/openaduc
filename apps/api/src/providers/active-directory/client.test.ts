// SPDX-License-Identifier: BUSL-1.1
import {
  BusyError,
  InvalidCredentialsError,
  InsufficientAccessError,
  UnavailableError,
} from 'ldapts';
import { describe, expect, it } from 'vitest';
import { certificateProblemMessage, isDirectoryUnreachable, transportFor } from './client.js';

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

describe('transportFor', () => {
  it('uses TLS from the start for ldaps:// URLs, whatever the mode', () => {
    expect(transportFor('ldaps://dc1:636', 'ldaps')).toBe('tls');
    expect(transportFor('ldaps://dc1:636', 'starttls')).toBe('tls');
  });

  it('upgrades ldap:// with StartTLS in StartTLS mode', () => {
    expect(transportFor('ldap://dc1:389', 'starttls')).toBe('starttls');
  });

  it('keeps an ldap:// URL in LDAPS mode on TLS rather than falling back to cleartext', () => {
    // Directories saved before URLs were validated: ldap://dc:636 under
    // LDAPS has always connected with TLS, and must keep doing so.
    expect(transportFor('ldap://dc1:636', 'ldaps')).toBe('tls');
  });
});

describe('certificateProblemMessage', () => {
  const tlsErr = (code: string) => Object.assign(new Error(code), { code });

  it('tells an untrusted certificate apart from a wrong name or an expired one', () => {
    expect(certificateProblemMessage(tlsErr('SELF_SIGNED_CERT_IN_CHAIN'))).toMatch(
      /AD_TLS_CA_PATH/,
    );
    const wrongName = certificateProblemMessage(tlsErr('ERR_TLS_CERT_ALTNAME_INVALID'));
    expect(wrongName).toMatch(/doesn't name the host/);
    expect(wrongName).not.toMatch(/AD_TLS_CA_PATH/);
    const expired = certificateProblemMessage(tlsErr('CERT_HAS_EXPIRED'));
    expect(expired).toMatch(/expired/);
    expect(expired).not.toMatch(/AD_TLS_CA_PATH/);
  });

  it('finds the certificate failure of one DC among several', () => {
    const allDown = new AggregateError([
      tlsErr('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]);
    expect(certificateProblemMessage(new Error('wrapped', { cause: allDown }))).toMatch(
      /isn't trusted/,
    );
  });

  it('is null for failures that have nothing to do with certificates', () => {
    expect(certificateProblemMessage(tlsErr('ECONNREFUSED'))).toBeNull();
    expect(certificateProblemMessage(new Error('Connection timeout'))).toBeNull();
  });
});
