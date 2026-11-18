import { ResultSetHeader, RowDataPacket } from 'mysql2'
import db from '../db'
import * as config from '../config'
import { formatDisputePayload, formatIsoDate, roundToTwo } from '../utils/helpers'

export const queryRows = async <T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: any[] = [],
): Promise<T[]> => {
  const [rows] = await db.query<T[]>(sql, params)
  return rows
}

export const queryOne = async <T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params: any[] = [],
): Promise<T | null> => {
  const rows = await queryRows<T>(sql, params)
  return rows[0] || null
}

export const executeQuery = async (sql: string, params: any[] = []): Promise<ResultSetHeader> => {
  const [result] = await db.query<ResultSetHeader>(sql, params)
  return result
}

export const getAdminEmailsQuery = async (): Promise<string[]> => {
  try {
    const rows = await queryRows<RowDataPacket>("SELECT email FROM users WHERE role = 'admin'")
    if (rows.length > 0) {
      return rows.map((r) => String(r.email).trim()).filter(Boolean)
    }
  } catch (err) {
    console.error('Failed to query admin emails from DB:', err)
  }
  return [config.DEFAULT_ADMIN_EMAIL]
}

let disputeTablesEnsured = false

export const ensureDisputeTables = async (): Promise<void> => {
  if (disputeTablesEnsured) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS disputes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      case_number VARCHAR(32) NOT NULL UNIQUE,
      buyer_token VARCHAR(64) NOT NULL UNIQUE,
      sale_id INT NOT NULL,
      order_id VARCHAR(100) NOT NULL,
      group_order_id VARCHAR(100) NULL,
      order_type ENUM('Product', 'Service') NOT NULL DEFAULT 'Product',
      seller_id INT NOT NULL,
      buyer_name VARCHAR(255) NOT NULL,
      buyer_email VARCHAR(255) NOT NULL,
      seller_name VARCHAR(255) NOT NULL,
      item_summary TEXT NOT NULL,
      selected_items_json LONGTEXT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      reason VARCHAR(255) NOT NULL,
      requested_solution VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      status ENUM('Awaiting seller', 'Awaiting buyer', 'Admin review', 'Resolved', 'Closed') NOT NULL DEFAULT 'Awaiting seller',
      payment_status ENUM('Paid', 'Refund pending', 'Partially refunded', 'Refunded', 'Not captured') NOT NULL DEFAULT 'Paid',
      legal_basis VARCHAR(500) NULL,
      purchase_date DATETIME NULL,
      defect_discovered_date DATE NULL,
      service_date DATE NULL,
      complaint_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      response_deadline DATETIME NULL,
      resolution_type VARCHAR(255) NULL,
      resolution_responsible VARCHAR(255) NULL,
      refund_amount DECIMAL(12,2) NULL,
      resolution_note TEXT NULL,
      resolution_summary TEXT NULL,
      admin_note TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_disputes_seller (seller_id),
      INDEX idx_disputes_sale (sale_id),
      INDEX idx_disputes_status (status)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS dispute_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      dispute_id INT NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      author_role ENUM('Buyer', 'Seller', 'Admin', 'System') NOT NULL,
      message_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dispute_messages_dispute (dispute_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id INT AUTO_INCREMENT PRIMARY KEY,
      dispute_id INT NOT NULL,
      uploaded_by_role ENUM('Buyer', 'Seller', 'Admin') NOT NULL,
      uploaded_by_name VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url VARCHAR(500) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dispute_evidence_dispute (dispute_id)
    )
  `)
  const extraCols: Array<{ name: string; ddl: string }> = [
    { name: 'service_booking_id', ddl: 'ALTER TABLE disputes ADD COLUMN service_booking_id INT NULL AFTER service_date' },
    { name: 'requested_booking_date', ddl: 'ALTER TABLE disputes ADD COLUMN requested_booking_date DATE NULL AFTER service_booking_id' },
    { name: 'requested_start_time', ddl: 'ALTER TABLE disputes ADD COLUMN requested_start_time VARCHAR(10) NULL AFTER requested_booking_date' },
    { name: 'requested_end_time', ddl: 'ALTER TABLE disputes ADD COLUMN requested_end_time VARCHAR(10) NULL AFTER requested_start_time' },
  ]
  for (const col of extraCols) {
    const [existing] = await db.query<RowDataPacket[]>(`SHOW COLUMNS FROM disputes LIKE ?`, [col.name])
    if (!existing.length) {
      await db.query(col.ddl)
    }
  }
  disputeTablesEnsured = true
}

export const resolveSellerDisputeDisplayName = async (sellerId: number): Promise<string> => {
  if (!Number.isFinite(sellerId) || sellerId <= 0) return 'Seller'
  const p = await queryOne<RowDataPacket>(
    `SELECT display_name, company_name, first_name, last_name
     FROM profiles
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [sellerId],
  )
  if (!p) return 'Seller'
  const display = String(p.display_name || '').trim()
  if (display) return display
  const company = String(p.company_name || '').trim()
  if (company) return company
  const fullName = [String(p.first_name || '').trim(), String(p.last_name || '').trim()].filter(Boolean).join(' ')
  return fullName || 'Seller'
}

export const loadDisputesWithChildren = async (whereSql: string, params: any[]) => {
  await ensureDisputeTables()
  const rows = await queryRows<RowDataPacket>(
    `SELECT d.*,
      COALESCE(NULLIF(TRIM(sp.display_name), ''), NULLIF(TRIM(sp.company_name), ''), NULLIF(TRIM(CONCAT_WS(' ', sp.first_name, sp.last_name)), ''), CASE WHEN d.seller_name LIKE '%@%' THEN 'Seller' ELSE d.seller_name END, 'Seller') AS resolved_seller_name
     FROM disputes d
     LEFT JOIN profiles sp ON sp.id = (
       SELECT p2.id FROM profiles p2 WHERE p2.user_id = d.seller_id ORDER BY p2.created_at DESC, p2.id DESC LIMIT 1
     )
     ${whereSql.replace(/\bseller_id\b/g, 'd.seller_id').replace(/\bbuyer_token\b/g, 'd.buyer_token').replace(/\bid\b/g, 'd.id')}
     ORDER BY d.updated_at DESC, d.id DESC`,
    params,
  )
  if (!rows.length) return []
  const ids = rows.map((r) => Number(r.id))
  const msgRows = await queryRows<RowDataPacket>(
    `SELECT * FROM dispute_messages WHERE dispute_id IN (?) ORDER BY created_at ASC, id ASC`,
    [ids],
  )
  const evRows = await queryRows<RowDataPacket>(
    `SELECT * FROM dispute_evidence WHERE dispute_id IN (?) ORDER BY created_at ASC, id ASC`,
    [ids],
  )
  const sellerNameByDisputeId = new Map<number, string>()
  for (const r of rows) {
    r.seller_name = String(r.resolved_seller_name || 'Seller')
    sellerNameByDisputeId.set(Number(r.id), r.seller_name)
  }
  const msgMap = new Map<number, any[]>()
  for (const m of msgRows) {
    const did = Number(m.dispute_id)
    if (m.author_role === 'Seller') {
      m.author_name = sellerNameByDisputeId.get(did) || 'Seller'
    }
    if (!msgMap.has(did)) msgMap.set(did, [])
    msgMap.get(did)!.push(m)
  }
  const evMap = new Map<number, any[]>()
  for (const e of evRows) {
    const did = Number(e.dispute_id)
    if (e.uploaded_by_role === 'Seller') {
      e.uploaded_by_name = sellerNameByDisputeId.get(did) || 'Seller'
    }
    if (!evMap.has(did)) evMap.set(did, [])
    evMap.get(did)!.push(e)
  }
  return rows.map((r) => formatDisputePayload(r, msgMap.get(Number(r.id)) || [], evMap.get(Number(r.id)) || []))
}

export const loadSingleDisputeById = async (disputeId: number) => {
  const list = await loadDisputesWithChildren('WHERE id = ?', [disputeId])
  return list[0] || null
}

export const lookupOrdersForDisputeQuery = async (rawOrderRef: string) => {
  const saleRows = await queryRows<RowDataPacket>(
    `SELECT
      s.id AS sale_id,
      s.order_id,
      s.group_order_id,
      s.seller_id,
      s.order_date,
      s.order_status,
      s.grand_total,
      s.payout_status,
      c.name AS buyer_name,
      c.email AS buyer_email,
      u.email AS seller_email,
      COALESCE(NULLIF(TRIM(sp.display_name), ''), NULLIF(TRIM(sp.company_name), ''), NULLIF(TRIM(CONCAT_WS(' ', sp.first_name, sp.last_name)), ''), 'Seller') AS seller_name
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.seller_id
     LEFT JOIN profiles sp ON sp.id = (
       SELECT p2.id FROM profiles p2 WHERE p2.user_id = s.seller_id ORDER BY p2.created_at DESC, p2.id DESC LIMIT 1
     )
     WHERE s.order_id = ? OR s.group_order_id = ?
        OR s.id IN (SELECT sb.sale_id FROM service_bookings sb WHERE sb.booking_code = ? AND sb.sale_id IS NOT NULL)
     ORDER BY s.id ASC`,
    [rawOrderRef, rawOrderRef, rawOrderRef],
  )
  if (!saleRows.length) return []

  const saleIds = saleRows.map((r) => Number(r.sale_id))
  const itemRows = await queryRows<RowDataPacket>(
    `SELECT
      si.id AS sale_item_id,
      si.sale_id,
      si.product_type,
      si.product_id,
      si.product_name,
      si.quantity,
      si.unit_price,
      si.tax_amount,
      CASE WHEN si.product_type = 'item' AND si.product_id IS NULL THEN 'Service' ELSE 'Product' END AS item_kind,
      COALESCE(p.type, CASE WHEN si.product_id IS NULL THEN 'service' ELSE 'physical' END) AS product_subtype,
      sb.id AS booking_id,
      sb.service_id,
      sb.booking_code,
      sb.booking_date,
      sb.start_time,
      sb.end_time,
      sb.status AS booking_status
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     LEFT JOIN service_bookings sb ON sb.id = (
       SELECT sb2.id FROM service_bookings sb2 WHERE sb2.sale_id = si.sale_id ORDER BY sb2.id ASC LIMIT 1
     )
     WHERE si.sale_id IN (?) AND si.product_type = 'item'
     ORDER BY si.id ASC`,
    [saleIds],
  )

  const itemsBySale = new Map<number, any[]>()
  for (const item of itemRows) {
    const sid = Number(item.sale_id)
    if (!itemsBySale.has(sid)) itemsBySale.set(sid, [])
    const lineTotal = roundToTwo(Number(item.unit_price || 0) * Number(item.quantity || 1) + Number(item.tax_amount || 0))
    itemsBySale.get(sid)!.push({
      sale_item_id: Number(item.sale_item_id),
      sale_id: sid,
      product_id: item.product_id != null ? Number(item.product_id) : null,
      product_name: String(item.product_name || ''),
      quantity: Number(item.quantity || 1),
      unit_price: Number(item.unit_price || 0),
      tax_amount: Number(item.tax_amount || 0),
      line_total: lineTotal,
      item_kind: item.item_kind === 'Service' ? 'Service' : 'Product',
      service_id: item.service_id != null ? Number(item.service_id) : null,
      booking_id: item.booking_id != null ? Number(item.booking_id) : null,
      booking_code: item.booking_code || null,
      service_date: item.booking_date ? formatIsoDate(item.booking_date) : null,
      start_time: item.start_time ? String(item.start_time).slice(0, 5) : null,
      end_time: item.end_time ? String(item.end_time).slice(0, 5) : null,
      booking_status: item.booking_status || null,
    })
  }

  return saleRows.map((s) => {
    const items = itemsBySale.get(Number(s.sale_id)) || []
    const hasService = items.some((it) => it.item_kind === 'Service')
    return {
      sale_id: Number(s.sale_id),
      order_id: String(s.order_id),
      group_order_id: s.group_order_id || null,
      seller_id: Number(s.seller_id),
      seller_name: String(s.seller_name || 'Seller'),
      buyer_name: String(s.buyer_name || ''),
      buyer_email: String(s.buyer_email || ''),
      order_date: s.order_date,
      order_status: String(s.order_status || ''),
      grand_total: Number(s.grand_total || 0),
      order_type: hasService ? 'Service' : 'Product',
      items,
    }
  })
}
