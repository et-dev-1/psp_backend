/**
 * apply-schema.ts
 *
 * Runs schema.sql against the configured database at startup.
 * Safe to re-run: all statements use IF NOT EXISTS / INSERT IGNORE.
 * Checks for the `users` table as a sentinel — if it already exists the
 * schema is considered applied and the script exits immediately.
 *
 * Exit codes:
 *   0  — schema already applied or applied successfully
 *   1  — error (schema not applied, server should not start)
 */

import fs from 'fs/promises'
import path from 'path'
import mysql from 'mysql2/promise'
import bcrypt from 'bcrypt'
import dotenv from 'dotenv'

dotenv.config()

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()

if (!DATABASE_URL) {
  console.error('[apply-schema] DATABASE_URL is not set. Aborting.')
  process.exit(1)
}

async function ensureColumn(
  conn: mysql.Connection,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SHOW COLUMNS FROM ${tableName} LIKE ?`,
    [columnName],
  )

  if (rows.length > 0) return

  console.log(`[apply-schema] Adding ${tableName}.${columnName} ...`)
  await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

async function reconcileExistingSchema(conn: mysql.Connection) {
  const [profileTableRows] = await conn.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'profiles'")
  if (profileTableRows.length === 0) return

  await ensureColumn(conn, 'profiles', 'clearance_number', 'VARCHAR(50) NULL')
  await ensureColumn(conn, 'profiles', 'personal_account_number', 'VARCHAR(100) NULL')
  await ensureColumn(conn, 'profiles', 'personal_bank_name', 'VARCHAR(150) NULL')
  await ensureColumn(conn, 'profiles', 'company_logo_url', 'VARCHAR(2000) NULL')
  await ensureColumn(conn, 'profiles', 'company_bank_type', "ENUM('bankgiro', 'plusgiro') NULL")
  await ensureColumn(conn, 'profiles', 'company_account_number', 'VARCHAR(100) NULL')
  await ensureColumn(conn, 'profiles', 'status', "ENUM('pending', 'verified', 'blocked', 'rejected') DEFAULT 'pending'")
  await ensureColumn(conn, 'profiles', 'status_reason', 'TEXT NULL')
  await ensureColumn(conn, 'profiles', 'is_verified', 'BOOLEAN NOT NULL DEFAULT FALSE')
  await ensureColumn(conn, 'profiles', 'is_blocked', 'BOOLEAN NOT NULL DEFAULT FALSE')
  await ensureColumn(conn, 'profiles', 'rejection_reason', 'TEXT NULL')
  await ensureColumn(conn, 'profiles', 'blocked_reason', 'TEXT NULL')
}

async function main() {
  const conn = await mysql.createConnection({ uri: DATABASE_URL, multipleStatements: false })

  try {
    // Check sentinel table
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'users'")
    if (rows.length > 0) {
      console.log('[apply-schema] Base schema already exists. Reconciling incremental columns.')
      await reconcileExistingSchema(conn)
      await seedAdminUser(conn)
      return
    }

    console.log('[apply-schema] Applying schema.sql …')
    const schemaPath = path.join(__dirname, '..', '..', 'schema.sql')
    const sql = await fs.readFile(schemaPath, 'utf8')

    // Split on semicolons followed by optional whitespace/newline,
    // strip leading comment lines from each chunk, then discard empty chunks.
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.length > 0)

    for (const stmt of statements) {
      await conn.query(stmt)
    }

    await reconcileExistingSchema(conn)

    console.log('[apply-schema] Schema applied successfully.')
    await seedAdminUser(conn)
  } finally {
    await conn.end()
  }
}

async function seedAdminUser(conn: mysql.Connection) {
  const DEFAULT_ADMIN_EMAIL = 'admin@admin.com'
  const DEFAULT_ADMIN_PASSWORD = 'Admin1234!'

  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
  )

  if (rows.length > 0) {
    console.log('[apply-schema] Admin user already exists. Skipping seed.')
    return
  }

  const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12)
  await conn.query(
    `INSERT INTO users (email, password, role, email_is_verified) VALUES (?, ?, 'admin', TRUE)`,
    [DEFAULT_ADMIN_EMAIL, hashedPassword],
  )

  console.log('[apply-schema] Default admin user created.')
  console.log(`  Email:    ${DEFAULT_ADMIN_EMAIL}`)
  console.log(`  Password: ${DEFAULT_ADMIN_PASSWORD}`)
  console.log('  ⚠️  Change this password immediately after first login!')
}

main().catch((err) => {
  console.error('[apply-schema] Failed to apply schema:', err)
  process.exit(1)
})
