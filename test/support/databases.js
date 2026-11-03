// What every test shares about MongoDB: where it is, the production guard, and how test
// databases are dropped. Test databases are always named pos_test_<random>_..., so
// nothing here can reach the shop's own database (salim_pos) or another site's.

export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';

// Tests create and drop databases: never on the production server
export function refuseProduction() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Tests create and drop databases, so they never run with NODE_ENV=production');
  }
}

// Drops every database whose name starts with `prefix` (a pos_test_<random>_ prefix
// only), and returns their names
export async function dropDatabases(conn, prefix) {
  if (!/^pos_test_[0-9a-f]+_/.test(prefix)) throw new Error(`Not a test database prefix: ${prefix}`);
  const { databases } = await conn.db.admin().listDatabases({ nameOnly: true });
  const names = databases.map((d) => d.name).filter((name) => name.startsWith(prefix));
  for (const name of names) await conn.getClient().db(name).dropDatabase();
  return names;
}
