// Connection settings shared by migration and read-only schema-check CLIs.
// Matches the existing hosted TLS policy in src/lib/dbUrl.ts.
function dbConfig(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('sslrootcert');
  return { connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false };
}

module.exports = { dbConfig };
