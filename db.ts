import mysql from 'mysql2/promise'
import { DATABASE_URL } from './config'

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL environment variable')
}

const pool = mysql.createPool({
  uri: DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

/*
pool.on('connection', (connection) => {
  connection.query("SET time_zone = 'Europe/Paris'")
})
*/

export default pool
