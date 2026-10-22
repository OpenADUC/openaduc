# Throwaway Samba AD domain controller for OpenADUC development and
# integration tests. Not hardened; never expose it beyond localhost.
FROM debian:trixie-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      samba samba-ad-dc samba-ad-provision samba-dsdb-modules samba-vfs-modules \
      winbind ldb-tools ldap-utils openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/samba/smb.conf

COPY entrypoint.sh seed.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/seed.sh

EXPOSE 389 636
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
