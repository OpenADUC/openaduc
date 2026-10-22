#!/bin/sh
# Provision the dev domain on first start, then run samba in the foreground.
# State lives in /var/lib/samba (a named volume), so restarts keep the
# domain; `pnpm dc:down` removes the volume for a clean slate.
set -eu

REALM="${DC_REALM:-OPENADUC.TEST}"
DOMAIN="${DC_DOMAIN:-OPENADUC}"
ADMIN_PASSWORD="${DC_ADMIN_PASSWORD:-OpenADUC-dev-Admin1}"
TLS_DIR=/var/lib/samba/private/tls/openaduc

gen_tls() {
  # Own CA + server cert so clients can verify the chain. The SAN covers the
  # names a developer or test uses to reach the container.
  mkdir -p "$TLS_DIR"
  cd "$TLS_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=OpenADUC Dev CA" \
    -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=dc1.openaduc.test" \
    -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=DNS:dc1.openaduc.test,DNS:dc1,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > ext.cnf
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 3650 \
    -extfile ext.cnf -out server.pem 2>/dev/null
  chmod 600 server.key ca.key
  cd /
}

if [ ! -f /var/lib/samba/private/sam.ldb ]; then
  echo "provisioning ${REALM}…"
  rm -f /etc/samba/smb.conf
  samba-tool domain provision \
    --realm="$REALM" --domain="$DOMAIN" --server-role=dc \
    --dns-backend=SAMBA_INTERNAL --use-rfc2307 \
    --host-name=dc1 --adminpass="$ADMIN_PASSWORD" \
    --option="acl_xattr:security_acl_name = user.NTACL" \
    --option="dns update command = /bin/true"
  gen_tls
  # Point samba at our cert instead of its auto-generated, CA-less one.
  sed -i "/^\[global\]/a\\
\ttls enabled = yes\\
\ttls keyfile = ${TLS_DIR}/server.key\\
\ttls certfile = ${TLS_DIR}/server.pem\\
\ttls cafile = ${TLS_DIR}/ca.pem" /etc/samba/smb.conf
  cp /etc/samba/smb.conf /var/lib/samba/private/smb.conf.openaduc
else
  # smb.conf lives outside the volume; restore the provisioned copy.
  cp /var/lib/samba/private/smb.conf.openaduc /etc/samba/smb.conf
fi

# Publish the CA for the API (AD_TLS_CA_PATH) and for host-side tools.
if [ -d /export ]; then cp "$TLS_DIR/ca.pem" /export/ca.pem; chmod 644 /export/ca.pem; fi

exec samba --foreground --no-process-group --debug-stdout
