// SPDX-License-Identifier: BUSL-1.1
import type { NewUserSettingsResponse } from '@openaduc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

describe('new user settings', () => {
  let api: TestApi;
  let admin: TestClient;
  let operator: TestClient;
  let url: string;

  beforeAll(async () => {
    api = await startApi();
    admin = await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    url = `/api/directories/${api.directoryId}/new-users`;
  });
  afterAll(async () => {
    await api?.close();
  });

  it('starts with mail from the UPN, random passwords and no default country', async () => {
    const res = await operator.get(url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<NewUserSettingsResponse>()).toEqual({
      newUsers: { mailFromUpn: true, passwordMode: 'random', phoneCountry: null },
    });
  });

  it('is changed by an admin, audited, and shown with the directory', async () => {
    const newUsers = { mailFromUpn: false, passwordMode: 'generate', phoneCountry: 'gb' };
    const res = await admin.put(url, newUsers);
    expect(res.statusCode, res.body).toBe(200);
    const saved = { mailFromUpn: false, passwordMode: 'generate', phoneCountry: 'GB' };
    expect(res.json<NewUserSettingsResponse>().newUsers).toEqual(saved);
    expect((await operator.get(url)).json<NewUserSettingsResponse>().newUsers).toEqual(saved);

    const listed = (await admin.get('/api/directories')).json<{
      directories: { id: number; newUsers: unknown }[];
    }>();
    expect(listed.directories.find((d) => d.id === api.directoryId)?.newUsers).toEqual(saved);
    const audit = await api.app.db
      .selectFrom('audit_events')
      .select(['result', 'before_json', 'after_json'])
      .where('action', '=', 'directory.newUsers.update')
      .execute();
    expect(audit).toEqual([
      {
        result: 'success',
        before_json: { mailFromUpn: true, passwordMode: 'random', phoneCountry: null },
        after_json: saved,
      },
    ]);
  });

  it('keeps the naming pattern when the defaults change, and the other way round', async () => {
    const naming = `/api/directories/${api.directoryId}/naming`;
    const pattern = { pattern: '{f}{last}', upnSuffix: 'openaduc.test' };
    expect((await admin.put(naming, pattern)).statusCode).toBe(200);
    const newUsers = { mailFromUpn: true, passwordMode: 'set', phoneCountry: null };
    expect((await admin.put(url, newUsers)).statusCode).toBe(200);
    expect((await admin.get(naming)).json<{ naming: unknown }>().naming).toEqual(pattern);
    expect((await admin.put(naming, { ...pattern, pattern: '{first}.{last}' })).statusCode).toBe(
      200,
    );
    expect((await admin.get(url)).json<NewUserSettingsResponse>().newUsers).toEqual(newUsers);
  });

  it('is refused to an operator, and to a country or mode it doesn’t know', async () => {
    const body = { mailFromUpn: true, passwordMode: 'random', phoneCountry: null };
    expect((await operator.put(url, body)).statusCode).toBe(403);
    expect((await admin.put(url, { ...body, phoneCountry: 'XX' })).statusCode).toBe(400);
    expect((await admin.put(url, { ...body, passwordMode: 'none' })).statusCode).toBe(400);
  });
});
