const test = require('node:test');
const assert = require('node:assert/strict');

const { phoneFromPnIdentity, resolveSenderPhone } = require('../server');

test('accepts phone identities but never treats a LID as a phone', () => {
  assert.equal(phoneFromPnIdentity('923266530045@c.us'), '923266530045');
  assert.equal(phoneFromPnIdentity('923266530045@s.whatsapp.net'), '923266530045');
  assert.equal(phoneFromPnIdentity('108675624613714@lid'), null);
});

test('resolves a sender LID through whatsapp-web.js PN mapping', async () => {
  const calls = [];
  const whatsappClient = {
    async getContactLidAndPhone(ids) {
      calls.push(ids);
      return [{ lid: ids[0], pn: '923266530045@c.us' }];
    },
  };
  const message = {
    from: '108675624613714@lid',
    async getContact() {
      throw new Error('contact fallback should not run');
    },
  };

  assert.deepEqual(await resolveSenderPhone(message, whatsappClient), {
    phone: '923266530045',
    source: 'lid-map',
  });
  assert.deepEqual(calls, [['108675624613714@lid']]);
});

test('prefers a PN author supplied by message metadata', async () => {
  const message = {
    from: '120363000000000000@g.us',
    author: '923266530045@c.us',
  };

  assert.deepEqual(await resolveSenderPhone(message, {}), {
    phone: '923266530045',
    source: 'message-pn',
  });
});

test('uses contact fallback without accepting its LID number', async () => {
  const whatsappClient = {
    async getContactLidAndPhone() {
      return [{ pn: undefined }];
    },
  };
  const message = {
    from: '108675624613714@lid',
    async getContact() {
      return {
        id: { _serialized: '108675624613714@lid' },
        number: '108675624613714',
        async getFormattedNumber() {
          return '+92 326 653 0045';
        },
      };
    },
  };

  assert.deepEqual(await resolveSenderPhone(message, whatsappClient), {
    phone: '923266530045',
    source: 'contact-formatted',
  });
});
