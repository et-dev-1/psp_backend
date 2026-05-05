import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import crypto from 'crypto'
import db from './db'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import * as config from './config'
import Stripe from 'stripe'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { RowDataPacket, ResultSetHeader } from 'mysql2'
import { createInvoiceEmailHtml, createDigitalProductEmailHtml, createShipmentNotificationEmailHtml, createSellerPayoutReceiptEmailHtml, sendEmail } from './email/email'
import { emitToAdmin, emitToSeller, setupWebSocket } from './websocket'
import { estimateShipmentCost, generateShipmentLabel, trackShipment, type ShipmentAddressInput } from './shipment/shipment'
import Handlebars from 'handlebars'
import { OAuth2Client } from 'google-auth-library'
import { generateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'
import SwishApi from './swish/SwishApi'

const stripe = new Stripe(config.STRIPE_SECRET_KEY)
let swishApi: SwishApi | null = null

if (config.SWISH_ENABLED) {
  try {
    swishApi = new SwishApi({ testMode: config.SWISH_TEST_MODE })
    const swishEnvironment = swishApi.getEnvironmentInfo()
    console.log(`[Swish API] Environment: ${swishEnvironment.testMode ? 'Merchant Swish Simulator' : 'Production'} (${swishEnvironment.baseHost})`)
  } catch (error) {
    console.warn('[Swish API] Disabled at startup. Certificates not found or invalid.', error)
  }
} else {
  console.log('[Swish API] Disabled by environment variable SWISH_ENABLED=false')
}

const DEFAULT_PLATFORM_COMMISSION_PERCENT = config.DEFAULT_PLATFORM_COMMISSION_PERCENT
const DEFAULT_PLATFORM_COMMISSION_FIXED = config.DEFAULT_PLATFORM_COMMISSION_FIXED
const DEFAULT_PROMOTION_COMMISSION_PERCENT = config.PROMOTION_COMMISSION_PERCENT
let VAT_SHIPPING_RATE = config.VAT_SHIPPING_RATE // 0.25 = 25% VAT
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
const AUTH_CAPTCHA_TTL_MS = 10 * 60 * 1000

const toBoolSetting = (value: unknown, fallback = false): boolean => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

interface AuthPayload {
  id: number
}

interface AuthWithRole extends AuthPayload {
  role: 'seller' | 'admin'
}

interface PaymentMethod {
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  name: string | null
}

const app = express()

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true })
})

// ✅ CORS MUST be before routes - use dynamic origin checker for private network support
app.use(
  cors({
    origin: (origin, callback) => {
      if (config.DISABLE_CORS_ORIGIN_CHECK) {
        callback(null, true)
      } else if (config.isOriginAllowed(origin)) {
        callback(null, true)
      } else if (!origin) {
        // Allow non-browser callers such as health checks, curl, and server-to-server requests.
        callback(null, true)
      } else {
        callback(new Error('CORS not allowed'))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
)

// ✅ Handle preflight requests (Express 5 requires named wildcard)
app.options('/{*splat}', cors())

app.use(express.json())

// Configure multer for file uploads
const uploadDir = path.join(__dirname, 'uploads', 'products')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const supportUploadDir = path.join(__dirname, 'uploads', 'support')
if (!fs.existsSync(supportUploadDir)) {
  fs.mkdirSync(supportUploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'attachments') {
      cb(null, supportUploadDir)
      return
    }

    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'images' || file.fieldname === 'variant_images') {
      const allowedImageTypes = /jpeg|jpg|png|gif|webp/
      const extname = allowedImageTypes.test(path.extname(file.originalname).toLowerCase())
      const mimetype = allowedImageTypes.test(file.mimetype)
      if (extname && mimetype) {
        return cb(null, true)
      }
      return cb(new Error('Only image files are allowed for product images'))
    }

    if (file.fieldname === 'digital_file' || file.fieldname === 'variant_files') {
      const allowedDigitalTypes = /pdf|jpeg|jpg|png|gif|webp/
      const extname = allowedDigitalTypes.test(path.extname(file.originalname).toLowerCase())
      const mimetype =
        file.mimetype === 'application/pdf' || /image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)

      if (extname && mimetype) {
        return cb(null, true)
      }

      return cb(new Error('Digital file must be a PDF or image file'))
    }

    if (file.fieldname === 'attachments') {
      const allowedAttachmentTypes = /pdf|jpeg|jpg|png|gif|webp/
      const extname = allowedAttachmentTypes.test(path.extname(file.originalname).toLowerCase())
      const mimetype =
        file.mimetype === 'application/pdf' || /image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)

      if (extname && mimetype) {
        return cb(null, true)
      }

      return cb(new Error('Support attachments must be PDF or image files'))
    }

    return cb(new Error('Unexpected file field'))
  },
})

const productUpload = upload.fields([
  { name: 'images', maxCount: 10 },
  { name: 'digital_file', maxCount: 1 },
  { name: 'variant_images', maxCount: 50 },
  { name: 'variant_files', maxCount: 50 },
])

const supportUpload = upload.array('attachments', 5)

// Serve static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

const getAuthToken = (req: Request): string | null => {
  const authHeader = req.headers['authorization']
  return authHeader ? authHeader.split(' ')[1] : null
}

const requireAuth = (req: Request, res: Response): AuthPayload | null => {
  // Skip token check if DISABLE_AUTH_CHECK is set (for testing)
  if (config.DISABLE_AUTH_CHECK) {
    console.log('⚠️ WARNING: Authentication check is DISABLED for testing')
    return { id: 1 } // Mock user ID for testing
  }

  const token = getAuthToken(req)
  if (!token) {
    res.status(401).json({ message: 'Access denied' })
    return null
  }
  try {
    return jwt.verify(token, config.JWT_SECRET) as AuthPayload
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' })
    return null
  }
}

const toCETDateTime = (value?: Date | string): string | null => {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return null

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second}`
}

let hasProductSkuColumnCache: boolean | null = null
let hasProductRejectionMessageColumnCache: boolean | null = null
let hasProductIsPromotedColumnCache: boolean | null = null
let hasShipmentPolicyVatRateColumnCache: boolean | null = null
let hasSalesOrderDateColumnCache: boolean | null = null
let hasSalesPayoutStatusColumnCache: boolean | null = null
let hasSalesPayoutPaymentDateColumnCache: boolean | null = null
let hasSalesPayoutReferenceColumnCache: boolean | null = null
let hasSalesPaymentIntentIdColumnCache: boolean | null = null
let hasSalesShipmentTrackingNumberColumnCache: boolean | null = null
let hasSalesShipmentLabelUrlColumnCache: boolean | null = null
let hasSalesShipmentLabelMimeTypeColumnCache: boolean | null = null
let hasSalesShipmentLabelGeneratedAtColumnCache: boolean | null = null
let hasSalesShipmentBookingIdColumnCache: boolean | null = null
let hasSalesStatusReasonColumnCache: boolean | null = null
let hasUsersIs2FaEnabledColumnCache: boolean | null = null
let hasUsersTwoFaSecretColumnCache: boolean | null = null
let hasUsersEmailIsVerifiedColumnCache: boolean | null = null
let hasUsersEmailVerificationTokenColumnCache: boolean | null = null
let hasUsersPasswordResetTokenHashColumnCache: boolean | null = null
let hasUsersPasswordResetExpiresAtColumnCache: boolean | null = null
let hasUsersGoogleSubColumnCache: boolean | null = null
let hasUsersNotifyOrderReceivedColumnCache: boolean | null = null
let hasUsersNotifyPaymentReceivedColumnCache: boolean | null = null
let hasUsersNotifyFeedbackReceivedColumnCache: boolean | null = null
let hasUsersNotifyAdminMessageColumnCache: boolean | null = null
let hasUsersNotifyProductApprovedColumnCache: boolean | null = null
let hasUsersPreferredThemeColumnCache: boolean | null = null
let hasProfilePictureUrlColumnCache: boolean | null = null
let hasProfileDisplayNameColumnCache: boolean | null = null
let hasProfilesStatusColumnCache: boolean | null = null
let hasProfilesStatusReasonColumnCache: boolean | null = null
let hasProfilesRejectionReasonColumnCache: boolean | null = null
let hasProfilesIsBlockedColumnCache: boolean | null = null
let hasProfilesBlockedReasonColumnCache: boolean | null = null
let hasProfilesCompanyAddressColumnCache: boolean | null = null
let hasProfilesUpdatedAtColumnCache: boolean | null = null
let hasBankAccountsTableCache: boolean | null = null
let hasCommissionSettingsTableCache: boolean | null = null
let hasSupportMessagesTableCache: boolean | null = null
let hasShipmentLabelsTableCache: boolean | null = null

const pendingTwoFaSecrets = new Map<number, { secret: string; expiresAt: number }>()
const authCaptchaChallenges = new Map<string, { answer: string; expiresAt: number }>()
const TWO_FA_SETUP_TTL_MS = 10 * 60 * 1000
const SELLER_PROFILE_STATUSES = ['pending', 'verified', 'blocked', 'rejected'] as const

type SellerProfileStatus = (typeof SELLER_PROFILE_STATUSES)[number]
type SellerProfileStatusSource = {
  [key: string]: unknown
  status?: string | null
  status_reason?: string | null
  is_verified?: number | boolean | null
  is_blocked?: number | boolean | null
  rejection_reason?: string | null
  blocked_reason?: string | null
}

const normalizeSellerProfileStatus = (value: unknown): SellerProfileStatus | null => {
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  return SELLER_PROFILE_STATUSES.includes(normalized as SellerProfileStatus)
    ? normalized as SellerProfileStatus
    : null
}

const getSellerProfileStatus = (profile: SellerProfileStatusSource | null | undefined): SellerProfileStatus => {
  const explicitStatus = normalizeSellerProfileStatus(profile?.status)
  if (explicitStatus) {
    return explicitStatus
  }

  if (Number(profile?.is_blocked || 0) === 1) {
    return 'blocked'
  }

  if (Number(profile?.is_verified || 0) === 1) {
    return 'verified'
  }

  if (String(profile?.rejection_reason || '').trim()) {
    return 'rejected'
  }

  return 'pending'
}

const getSellerProfileStatusReason = (profile: SellerProfileStatusSource | null | undefined): string => {
  const directReason = String(profile?.status_reason || '').trim()
  if (directReason) {
    return directReason
  }

  const status = getSellerProfileStatus(profile)
  if (status === 'blocked') {
    return String(profile?.blocked_reason || '').trim()
  }

  if (status === 'rejected') {
    return String(profile?.rejection_reason || '').trim()
  }

  return ''
}

const buildSellerProfileCompatFields = (profile: SellerProfileStatusSource | null | undefined) => {
  const status = getSellerProfileStatus(profile)
  const statusReason = getSellerProfileStatusReason(profile)

  return {
    status,
    status_reason: statusReason || null,
    is_verified: status === 'verified' ? 1 : 0,
    is_blocked: status === 'blocked' ? 1 : 0,
    rejection_reason: status === 'rejected' ? statusReason || null : null,
    blocked_reason: status === 'blocked' ? statusReason || null : null,
  }
}

const ensureTwoFaColumns = async () => {
  try {
    if (hasUsersIs2FaEnabledColumnCache !== true) {
      const [is2FaRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'is_2fa_enabled'")
      if (is2FaRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN is_2fa_enabled BOOLEAN DEFAULT FALSE')
      }
      hasUsersIs2FaEnabledColumnCache = true
    }

    if (hasUsersTwoFaSecretColumnCache !== true) {
      const [secretRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'twofa_secret'")
      if (secretRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN twofa_secret VARCHAR(255) NULL')
      }
      hasUsersTwoFaSecretColumnCache = true
    }
  } catch (error) {
    hasUsersIs2FaEnabledColumnCache = null
    hasUsersTwoFaSecretColumnCache = null
    console.error('Failed ensuring 2FA columns:', error)
    throw error
  }
}

const ensureEmailVerificationColumns = async () => {
  try {
    if (hasUsersEmailIsVerifiedColumnCache !== true) {
      const [verifiedRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'email_is_verified'")
      if (verifiedRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN email_is_verified BOOLEAN NOT NULL DEFAULT TRUE')
      }
      hasUsersEmailIsVerifiedColumnCache = true
    }

    if (hasUsersEmailVerificationTokenColumnCache !== true) {
      const [tokenRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'email_verification_token'")
      if (tokenRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN email_verification_token VARCHAR(128) NULL')
      }
      hasUsersEmailVerificationTokenColumnCache = true
    }
  } catch (error) {
    hasUsersEmailIsVerifiedColumnCache = null
    hasUsersEmailVerificationTokenColumnCache = null
    console.error('Failed ensuring email verification columns:', error)
    throw error
  }
}

const ensurePasswordResetColumns = async () => {
  try {
    if (hasUsersPasswordResetTokenHashColumnCache !== true) {
      const [tokenRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'password_reset_token_hash'")
      if (tokenRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN password_reset_token_hash VARCHAR(128) NULL')
      }
      hasUsersPasswordResetTokenHashColumnCache = true
    }

    if (hasUsersPasswordResetExpiresAtColumnCache !== true) {
      const [expiryRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'password_reset_expires_at'")
      if (expiryRows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN password_reset_expires_at DATETIME NULL')
      }
      hasUsersPasswordResetExpiresAtColumnCache = true
    }
  } catch (error) {
    hasUsersPasswordResetTokenHashColumnCache = null
    hasUsersPasswordResetExpiresAtColumnCache = null
    console.error('Failed ensuring password reset columns:', error)
    throw error
  }
}

const ensureGoogleAuthColumns = async () => {
  try {
    if (hasUsersGoogleSubColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'google_sub'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN google_sub VARCHAR(255) NULL')
      }
      hasUsersGoogleSubColumnCache = true
    }
  } catch (error) {
    hasUsersGoogleSubColumnCache = null
    console.error('Failed ensuring Google auth columns:', error)
    throw error
  }
}

const ensureUserPreferenceColumns = async () => {
  try {
    if (hasUsersNotifyOrderReceivedColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'notify_order_received'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN notify_order_received BOOLEAN DEFAULT TRUE')
      }
      hasUsersNotifyOrderReceivedColumnCache = true
    }

    if (hasUsersNotifyPaymentReceivedColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'notify_payment_received'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN notify_payment_received BOOLEAN DEFAULT TRUE')
      }
      hasUsersNotifyPaymentReceivedColumnCache = true
    }

    if (hasUsersNotifyFeedbackReceivedColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'notify_feedback_received'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN notify_feedback_received BOOLEAN DEFAULT TRUE')
      }
      hasUsersNotifyFeedbackReceivedColumnCache = true
    }

    if (hasUsersNotifyAdminMessageColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'notify_admin_message'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN notify_admin_message BOOLEAN DEFAULT TRUE')
      }
      hasUsersNotifyAdminMessageColumnCache = true
    }

    if (hasUsersNotifyProductApprovedColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'notify_product_approved'")
      if (rows.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN notify_product_approved BOOLEAN DEFAULT TRUE')
      }
      hasUsersNotifyProductApprovedColumnCache = true
    }

    if (hasUsersPreferredThemeColumnCache !== true) {
      const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM users LIKE 'preferred_theme'")
      if (rows.length === 0) {
        await db.query("ALTER TABLE users ADD COLUMN preferred_theme ENUM('light', 'dark') DEFAULT 'light'")
      }
      hasUsersPreferredThemeColumnCache = true
    }
  } catch (error) {
    hasUsersNotifyOrderReceivedColumnCache = null
    hasUsersNotifyPaymentReceivedColumnCache = null
    hasUsersNotifyFeedbackReceivedColumnCache = null
    hasUsersNotifyAdminMessageColumnCache = null
    hasUsersNotifyProductApprovedColumnCache = null
    hasUsersPreferredThemeColumnCache = null
    console.error('Failed ensuring user preference columns:', error)
    throw error
  }
}

const hasProductSkuColumn = async (): Promise<boolean> => {
  if (hasProductSkuColumnCache !== null) {
    return hasProductSkuColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM products LIKE 'sku'")
    hasProductSkuColumnCache = rows.length > 0
    return hasProductSkuColumnCache
  } catch (error) {
    console.error('Unable to check products.sku column:', error)
    hasProductSkuColumnCache = false
    return false
  }
}

const hasProductRejectionMessageColumn = async (): Promise<boolean> => {
  if (hasProductRejectionMessageColumnCache !== null) {
    return hasProductRejectionMessageColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM products LIKE 'rejection_message'")
    const exists = rows.length > 0
    if (exists) {
      hasProductRejectionMessageColumnCache = true
    }
    return exists
  } catch (error) {
    console.error('Unable to check products.rejection_message column:', error)
    return false
  }
}

const hasProductIsPromotedColumn = async (): Promise<boolean> => {
  if (hasProductIsPromotedColumnCache !== null) {
    return hasProductIsPromotedColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM products LIKE 'is_promoted'")
    hasProductIsPromotedColumnCache = rows.length > 0
    return hasProductIsPromotedColumnCache
  } catch (error) {
    console.error('Unable to check products.is_promoted column:', error)
    hasProductIsPromotedColumnCache = false
    return false
  }
}

const hasProfilesRejectionReasonColumn = async (): Promise<boolean> => {
  if (hasProfilesRejectionReasonColumnCache !== null) {
    return hasProfilesRejectionReasonColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM profiles LIKE 'rejection_reason'")
    hasProfilesRejectionReasonColumnCache = rows.length > 0
    return hasProfilesRejectionReasonColumnCache
  } catch (error) {
    console.error('Unable to check profiles.rejection_reason column:', error)
    hasProfilesRejectionReasonColumnCache = false
    return false
  }
}

const ensureProfilesStatusColumns = async (): Promise<void> => {
  try {
    const [columnRows] = await db.query<RowDataPacket[]>('SHOW COLUMNS FROM profiles')
    const columnNames = new Set(columnRows.map((row) => String(row.Field || '')))

    if (!columnNames.has('status')) {
      await db.query("ALTER TABLE profiles ADD COLUMN status ENUM('pending', 'verified', 'blocked', 'rejected') DEFAULT 'pending'")
      columnNames.add('status')
    }

    if (!columnNames.has('status_reason')) {
      await db.query('ALTER TABLE profiles ADD COLUMN status_reason TEXT NULL')
      columnNames.add('status_reason')
    }

    const hasIsBlocked = columnNames.has('is_blocked')
    const hasIsVerified = columnNames.has('is_verified')
    const hasRejectionReason = columnNames.has('rejection_reason')
    const hasBlockedReason = columnNames.has('blocked_reason')
    const blockedCondition = hasIsBlocked ? 'COALESCE(is_blocked, 0) = 1' : 'FALSE'
    const verifiedCondition = hasIsVerified ? 'COALESCE(is_verified, 0) = 1' : 'FALSE'
    const rejectedCondition = hasRejectionReason ? "NULLIF(TRIM(rejection_reason), '') IS NOT NULL" : 'FALSE'
    const blockedReasonExpr = hasBlockedReason ? "NULLIF(TRIM(blocked_reason), '')" : 'NULL'
    const rejectionReasonExpr = hasRejectionReason ? "NULLIF(TRIM(rejection_reason), '')" : 'NULL'

    await db.query(`
      UPDATE profiles
      SET status = CASE
        WHEN ${blockedCondition} THEN 'blocked'
        WHEN ${verifiedCondition} THEN 'verified'
        WHEN ${rejectedCondition} THEN 'rejected'
        WHEN status IN ('pending', 'verified', 'blocked', 'rejected') THEN status
        ELSE 'pending'
      END,
      status_reason = CASE
        WHEN ${blockedCondition} THEN COALESCE(${blockedReasonExpr}, NULLIF(TRIM(status_reason), ''))
        WHEN ${rejectedCondition} THEN COALESCE(${rejectionReasonExpr}, NULLIF(TRIM(status_reason), ''))
        WHEN COALESCE(status, 'pending') = 'pending' THEN NULLIF(TRIM(status_reason), '')
        ELSE NULL
      END
    `)

    hasProfilesStatusColumnCache = true
    hasProfilesStatusReasonColumnCache = true
    if (hasIsBlocked) {
      hasProfilesIsBlockedColumnCache = true
    }
    if (hasBlockedReason) {
      hasProfilesBlockedReasonColumnCache = true
    }
    if (hasRejectionReason) {
      hasProfilesRejectionReasonColumnCache = true
    }
  } catch (error) {
    hasProfilesStatusColumnCache = null
    hasProfilesStatusReasonColumnCache = null
    hasProfilesIsBlockedColumnCache = null
    hasProfilesBlockedReasonColumnCache = null
    console.error('Failed ensuring profiles status columns:', error)
    throw error
  }
}

const ensureProfilesBlockColumns = async (): Promise<void> => {
	await ensureProfilesStatusColumns()
}

const hasProfilesCompanyAddressColumn = async (): Promise<boolean> => {
  if (hasProfilesCompanyAddressColumnCache !== null) {
    return hasProfilesCompanyAddressColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM profiles LIKE 'company_address'")
    hasProfilesCompanyAddressColumnCache = rows.length > 0
    return hasProfilesCompanyAddressColumnCache
  } catch (error) {
    console.error('Unable to check profiles.company_address column:', error)
    hasProfilesCompanyAddressColumnCache = false
    return false
  }
}

const hasProfilesUpdatedAtColumn = async (): Promise<boolean> => {
  if (hasProfilesUpdatedAtColumnCache !== null) {
    return hasProfilesUpdatedAtColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM profiles LIKE 'updated_at'")
    hasProfilesUpdatedAtColumnCache = rows.length > 0
    return hasProfilesUpdatedAtColumnCache
  } catch (error) {
    console.error('Unable to check profiles.updated_at column:', error)
    hasProfilesUpdatedAtColumnCache = false
    return false
  }
}

const hasShipmentPolicyVatRateColumn = async (): Promise<boolean> => {
  if (hasShipmentPolicyVatRateColumnCache !== null) {
    return hasShipmentPolicyVatRateColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM shipment_policies LIKE 'vat_rate'")
    hasShipmentPolicyVatRateColumnCache = rows.length > 0
    return hasShipmentPolicyVatRateColumnCache
  } catch (error) {
    console.error('Unable to check shipment_policies.vat_rate column:', error)
    hasShipmentPolicyVatRateColumnCache = false
    return false
  }
}

const hasSalesOrderDateColumn = async (): Promise<boolean> => {
  if (hasSalesOrderDateColumnCache !== null) {
    return hasSalesOrderDateColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'order_date'")
    hasSalesOrderDateColumnCache = rows.length > 0
    return hasSalesOrderDateColumnCache
  } catch (error) {
    console.error('Unable to check sales.order_date column:', error)
    hasSalesOrderDateColumnCache = false
    return false
  }
}

const hasSalesPayoutStatusColumn = async (): Promise<boolean> => {
  if (hasSalesPayoutStatusColumnCache !== null) {
    return hasSalesPayoutStatusColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payout_status'")
    hasSalesPayoutStatusColumnCache = rows.length > 0
    return hasSalesPayoutStatusColumnCache
  } catch (error) {
    console.error('Unable to check sales.payout_status column:', error)
    hasSalesPayoutStatusColumnCache = false
    return false
  }
}

const hasSalesPayoutPaymentDateColumn = async (): Promise<boolean> => {
  if (hasSalesPayoutPaymentDateColumnCache !== null) {
    return hasSalesPayoutPaymentDateColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payout_payment_date'")
    hasSalesPayoutPaymentDateColumnCache = rows.length > 0
    return hasSalesPayoutPaymentDateColumnCache
  } catch (error) {
    console.error('Unable to check sales.payout_payment_date column:', error)
    hasSalesPayoutPaymentDateColumnCache = false
    return false
  }
}

const hasSalesPayoutReferenceColumn = async (): Promise<boolean> => {
  if (hasSalesPayoutReferenceColumnCache !== null) {
    return hasSalesPayoutReferenceColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payout_reference'")
    hasSalesPayoutReferenceColumnCache = rows.length > 0
    return hasSalesPayoutReferenceColumnCache
  } catch (error) {
    console.error('Unable to check sales.payout_reference column:', error)
    hasSalesPayoutReferenceColumnCache = false
    return false
  }
}

const hasSalesPaymentIntentIdColumn = async (): Promise<boolean> => {
  if (hasSalesPaymentIntentIdColumnCache !== null) {
    return hasSalesPaymentIntentIdColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payment_intent_id'")
    hasSalesPaymentIntentIdColumnCache = rows.length > 0
    return hasSalesPaymentIntentIdColumnCache
  } catch (error) {
    console.error('Unable to check sales.payment_intent_id column:', error)
    hasSalesPaymentIntentIdColumnCache = false
    return false
  }
}

const ensureSalesPaymentIntentIdColumn = async () => {
  try {
    if (await hasSalesPaymentIntentIdColumn()) return

    await db.query('ALTER TABLE sales ADD COLUMN payment_intent_id VARCHAR(255) NULL')
    hasSalesPaymentIntentIdColumnCache = true
  } catch (error) {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payment_intent_id'")
    hasSalesPaymentIntentIdColumnCache = rows.length > 0
    if (!hasSalesPaymentIntentIdColumnCache) {
      console.error('Failed ensuring sales.payment_intent_id column:', error)
      throw error
    }
  }
}

const hasSalesShipmentTrackingNumberColumn = async (): Promise<boolean> => {
  if (hasSalesShipmentTrackingNumberColumnCache !== null) {
    return hasSalesShipmentTrackingNumberColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'shipment_tracking_number'")
    hasSalesShipmentTrackingNumberColumnCache = rows.length > 0
    return hasSalesShipmentTrackingNumberColumnCache
  } catch (error) {
    console.error('Unable to check sales.shipment_tracking_number column:', error)
    hasSalesShipmentTrackingNumberColumnCache = false
    return false
  }
}

const hasSalesShipmentLabelUrlColumn = async (): Promise<boolean> => {
  if (hasSalesShipmentLabelUrlColumnCache !== null) {
    return hasSalesShipmentLabelUrlColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'shipment_label_url'")
    hasSalesShipmentLabelUrlColumnCache = rows.length > 0
    return hasSalesShipmentLabelUrlColumnCache
  } catch (error) {
    console.error('Unable to check sales.shipment_label_url column:', error)
    hasSalesShipmentLabelUrlColumnCache = false
    return false
  }
}

const hasSalesShipmentLabelMimeTypeColumn = async (): Promise<boolean> => {
  if (hasSalesShipmentLabelMimeTypeColumnCache !== null) {
    return hasSalesShipmentLabelMimeTypeColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'shipment_label_mime_type'")
    hasSalesShipmentLabelMimeTypeColumnCache = rows.length > 0
    return hasSalesShipmentLabelMimeTypeColumnCache
  } catch (error) {
    console.error('Unable to check sales.shipment_label_mime_type column:', error)
    hasSalesShipmentLabelMimeTypeColumnCache = false
    return false
  }
}

const hasSalesShipmentLabelGeneratedAtColumn = async (): Promise<boolean> => {
  if (hasSalesShipmentLabelGeneratedAtColumnCache !== null) {
    return hasSalesShipmentLabelGeneratedAtColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'shipment_label_generated_at'")
    hasSalesShipmentLabelGeneratedAtColumnCache = rows.length > 0
    return hasSalesShipmentLabelGeneratedAtColumnCache
  } catch (error) {
    console.error('Unable to check sales.shipment_label_generated_at column:', error)
    hasSalesShipmentLabelGeneratedAtColumnCache = false
    return false
  }
}

const hasSalesShipmentBookingIdColumn = async (): Promise<boolean> => {
  if (hasSalesShipmentBookingIdColumnCache !== null) {
    return hasSalesShipmentBookingIdColumnCache
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'shipment_booking_id'")
    hasSalesShipmentBookingIdColumnCache = rows.length > 0
    return hasSalesShipmentBookingIdColumnCache
  } catch (error) {
    console.error('Unable to check sales.shipment_booking_id column:', error)
    hasSalesShipmentBookingIdColumnCache = false
    return false
  }
}

const ensureSalesStatusReasonColumn = async (): Promise<void> => {
  if (hasSalesStatusReasonColumnCache === true) {
    return
  }

  try {
    const [statusReasonRows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'status_reason'")
    const hasStatusReason = statusReasonRows.length > 0

    if (!hasStatusReason) {
      await db.query('ALTER TABLE sales ADD COLUMN status_reason TEXT NULL')
    }

    hasSalesStatusReasonColumnCache = true
  } catch (error) {
    hasSalesStatusReasonColumnCache = false
    console.error('Failed ensuring merged sales status_reason column:', error)
    throw error
  }
}

const ensureSalesShipmentColumns = async () => {
  try {
    const [hasTracking, hasLabelUrl, hasLabelMimeType, hasLabelGeneratedAt, hasBookingId] = await Promise.all([
      hasSalesShipmentTrackingNumberColumn(),
      hasSalesShipmentLabelUrlColumn(),
      hasSalesShipmentLabelMimeTypeColumn(),
      hasSalesShipmentLabelGeneratedAtColumn(),
      hasSalesShipmentBookingIdColumn(),
    ])

    if (!hasTracking) {
      await db.query('ALTER TABLE sales ADD COLUMN shipment_tracking_number VARCHAR(120) NULL')
    }
    if (!hasLabelUrl) {
      await db.query('ALTER TABLE sales ADD COLUMN shipment_label_url VARCHAR(700) NULL')
    }
    if (!hasLabelMimeType) {
      await db.query('ALTER TABLE sales ADD COLUMN shipment_label_mime_type VARCHAR(120) NULL')
    }
    if (!hasLabelGeneratedAt) {
      await db.query('ALTER TABLE sales ADD COLUMN shipment_label_generated_at DATETIME NULL')
    }
    if (!hasBookingId) {
      await db.query('ALTER TABLE sales ADD COLUMN shipment_booking_id VARCHAR(120) NULL')
    }

    hasSalesShipmentTrackingNumberColumnCache = true
    hasSalesShipmentLabelUrlColumnCache = true
    hasSalesShipmentLabelMimeTypeColumnCache = true
    hasSalesShipmentLabelGeneratedAtColumnCache = true
    hasSalesShipmentBookingIdColumnCache = true
  } catch (error) {
    hasSalesShipmentTrackingNumberColumnCache = false
    hasSalesShipmentLabelUrlColumnCache = false
    hasSalesShipmentLabelMimeTypeColumnCache = false
    hasSalesShipmentLabelGeneratedAtColumnCache = false
    hasSalesShipmentBookingIdColumnCache = false
    console.error('Failed ensuring sales shipment columns:', error)
  }
}

const ensureSalesPayoutColumns = async () => {
  try {
    const [[paymentDateColumnRows], [payoutReferenceColumnRows]] = await Promise.all([
      db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payout_payment_date'"),
      db.query<RowDataPacket[]>("SHOW COLUMNS FROM sales LIKE 'payout_reference'"),
    ])

    const paymentDateExists = paymentDateColumnRows.length > 0
    const payoutReferenceExists = payoutReferenceColumnRows.length > 0

    if (!paymentDateExists) {
      await db.query('ALTER TABLE sales ADD COLUMN payout_payment_date DATETIME NULL')
    }

    if (!payoutReferenceExists) {
      await db.query('ALTER TABLE sales ADD COLUMN payout_reference VARCHAR(120) NULL')
    }

    hasSalesPayoutPaymentDateColumnCache = true
    hasSalesPayoutReferenceColumnCache = true
  } catch (error) {
    hasSalesPayoutPaymentDateColumnCache = false
    hasSalesPayoutReferenceColumnCache = false
    console.error('Failed ensuring sales payout columns:', error)
  }
}

const requireAdmin = async (req: Request, res: Response): Promise<AuthPayload | null> => {
  const auth = requireAuth(req, res)
  if (!auth) return null

  try {
    const [rows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    if (!rows.length || rows[0].role !== 'admin') {
      res.status(403).json({ message: 'Admin access required' })
      return null
    }
    return auth
  } catch (error) {
    console.error('Failed to validate admin role:', error)
    res.status(500).json({ message: 'Database error' })
    return null
  }
}

const requireSellerOrAdmin = async (req: Request, res: Response): Promise<AuthWithRole | null> => {
  const auth = requireAuth(req, res)
  if (!auth) return null

  try {
    const [rows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    const role = String(rows[0]?.role || '').toLowerCase()

    if (role !== 'seller' && role !== 'admin') {
      res.status(403).json({ message: 'Seller or admin access required' })
      return null
    }

    return {
      id: auth.id,
      role: role as 'seller' | 'admin',
    }
  } catch (error) {
    console.error('Failed to validate seller/admin role:', error)
    res.status(500).json({ message: 'Database error' })
    return null
  }
}

const fsPromises = fs.promises;
const ensureCommissionSettingsTable = async () => {
  // --- API to run schema.sql ---
  app.post('/run-schema', async (req, res) => {
    // Only allow admin users to run this endpoint
    const auth = await requireAdmin(req, res);
    if (!auth) return;

    try {
      const schemaPath = path.join(__dirname, 'schema.sql');
      const sql = await fsPromises.readFile(schemaPath, 'utf8');

      // Split SQL by semicolon, filter out empty lines
      const statements = sql
        .split(/;\s*\n/)
        .map((stmt) => stmt.trim())
        .filter((stmt) => stmt.length > 0);

      const conn = await db.getConnection();
      try {
        for (const stmt of statements) {
          await conn.query(stmt);
        }
        res.json({ ok: true, message: 'schema.sql executed successfully' });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error('Error running schema.sql:', error);
      res.status(500).json({ ok: false, error: String(error) });
    }
  });
  try {
    if (hasCommissionSettingsTableCache === true) return

    await db.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `)

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('platform_commission_percent', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(DEFAULT_PLATFORM_COMMISSION_PERCENT)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('platform_commission_fixed', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(DEFAULT_PLATFORM_COMMISSION_FIXED)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('promotion_commission_percent', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(DEFAULT_PROMOTION_COMMISSION_PERCENT)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('vat_shipping_rate', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.VAT_SHIPPING_RATE)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_address', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.EMAIL.address || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_company_name', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.EMAIL.companyName || 'Smart Embedded System')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_company_address', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.EMAIL.companyAddress || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_company_logo_url', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.EMAIL.companyLogoUrl || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_use_test_receiver', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(Boolean(config.EMAIL.useTestReceiver))],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('email_test_receiver', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.EMAIL.testReceiver || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('company_organization_number', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.COMPANY_ORGANIZATION_NUMBER || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('postnord_customer_number', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.POSTNORD.customerNumber || '')],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('postnord_debug_logs', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(Boolean(config.POSTNORD.debugLogs))],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('postnord_use_portal_pricing', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(Boolean(config.POSTNORD.usePortalPricing))],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('postnord_enable_transit_time', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(Boolean(config.POSTNORD.enableTransitTime))],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('google_client_id', ?)
       ON DUPLICATE KEY UPDATE setting_value = setting_value`,
      [String(config.GOOGLE_CLIENT_ID || '')],
    )

    hasCommissionSettingsTableCache = true
  } catch (error) {
    hasCommissionSettingsTableCache = null
    console.error('Failed ensuring commission settings table:', error)
    throw error
  }
}

type RuntimeSettings = {
  platform_commission_percent: number
  platform_commission_fixed: number
  promotion_commission_percent: number
  vat_shipping_rate: number
  email_address: string
  email_company_name: string
  email_company_address: string
  email_company_logo_url: string
  email_use_test_receiver: boolean
  email_test_receiver: string
  company_organization_number: string
  postnord_customer_number: string
  postnord_debug_logs: boolean
  postnord_use_portal_pricing: boolean
  postnord_enable_transit_time: boolean
  google_client_id: string
}

const applyRuntimeSettings = (settings: RuntimeSettings) => {
  process.env.VAT_SHIPPING_RATE = String(settings.vat_shipping_rate)
  process.env.EMAIL_ADDRESS = settings.email_address
  process.env.EMAIL_COMPANY_NAME = settings.email_company_name
  process.env.EMAIL_COMPANY_ADDRESS = settings.email_company_address
  process.env.EMAIL_COMPANY_LOGO_URL = settings.email_company_logo_url
  process.env.EMAIL_USE_TEST_RECEIVER = String(settings.email_use_test_receiver)
  process.env.EMAIL_TEST_RECEIVER = settings.email_test_receiver
  process.env.COMPANY_ORGANIZATION_NUMBER = settings.company_organization_number
  process.env.POSTNORD_CUSTOMER_NUMBER = settings.postnord_customer_number
  process.env.POSTNORD_DEBUG_LOGS = String(settings.postnord_debug_logs)
  process.env.POSTNORD_USE_PORTAL_PRICING = String(settings.postnord_use_portal_pricing)
  process.env.POSTNORD_ENABLE_TRANSIT_TIME = String(settings.postnord_enable_transit_time)
  process.env.GOOGLE_CLIENT_ID = settings.google_client_id

  VAT_SHIPPING_RATE = settings.vat_shipping_rate
  config.EMAIL.address = settings.email_address
  config.EMAIL.companyName = settings.email_company_name
  config.EMAIL.companyAddress = settings.email_company_address
  config.EMAIL.companyLogoUrl = settings.email_company_logo_url
  config.EMAIL.useTestReceiver = settings.email_use_test_receiver
  config.EMAIL.testReceiver = settings.email_test_receiver
  config.POSTNORD.customerNumber = settings.postnord_customer_number
  config.POSTNORD.debugLogs = settings.postnord_debug_logs
  config.POSTNORD.usePortalPricing = settings.postnord_use_portal_pricing
  config.POSTNORD.enableTransitTime = settings.postnord_enable_transit_time
}

const getRuntimeSettings = async (): Promise<RuntimeSettings> => {
  await ensureCommissionSettingsTable()
  const keys = [
    'platform_commission_percent',
    'platform_commission_fixed',
    'promotion_commission_percent',
    'vat_shipping_rate',
    'email_address',
    'email_company_name',
    'email_company_address',
    'email_company_logo_url',
    'email_use_test_receiver',
    'email_test_receiver',
    'company_organization_number',
    'postnord_customer_number',
    'postnord_debug_logs',
    'postnord_use_portal_pricing',
    'postnord_enable_transit_time',
    'google_client_id',
  ]

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)`,
    [keys],
  )

  const map = new Map<string, string>()
  for (const row of rows) {
    map.set(String(row.setting_key), String(row.setting_value))
  }

  const platformPercent = Number(map.get('platform_commission_percent'))
  const platformFixed = Number(map.get('platform_commission_fixed'))
  const promotionPercent = Number(map.get('promotion_commission_percent'))
  const vatShippingRate = Number(map.get('vat_shipping_rate'))

  return {
    platform_commission_percent: Number.isFinite(platformPercent) ? platformPercent : DEFAULT_PLATFORM_COMMISSION_PERCENT,
    platform_commission_fixed: Number.isFinite(platformFixed) ? platformFixed : DEFAULT_PLATFORM_COMMISSION_FIXED,
    promotion_commission_percent: Number.isFinite(promotionPercent) ? promotionPercent : DEFAULT_PROMOTION_COMMISSION_PERCENT,
    vat_shipping_rate: Number.isFinite(vatShippingRate) ? vatShippingRate : config.VAT_SHIPPING_RATE,
    email_address: String(map.get('email_address') || config.EMAIL.address || ''),
    email_company_name: String(map.get('email_company_name') || config.EMAIL.companyName || 'Smart Embedded System'),
    email_company_address: String(map.get('email_company_address') || config.EMAIL.companyAddress || ''),
    email_company_logo_url: String(map.get('email_company_logo_url') || config.EMAIL.companyLogoUrl || ''),
    email_use_test_receiver: toBoolSetting(map.get('email_use_test_receiver'), Boolean(config.EMAIL.useTestReceiver)),
    email_test_receiver: String(map.get('email_test_receiver') || config.EMAIL.testReceiver || ''),
    company_organization_number: String(map.get('company_organization_number') || config.COMPANY_ORGANIZATION_NUMBER || ''),
    postnord_customer_number: String(map.get('postnord_customer_number') || config.POSTNORD.customerNumber || ''),
    postnord_debug_logs: toBoolSetting(map.get('postnord_debug_logs'), Boolean(config.POSTNORD.debugLogs)),
    postnord_use_portal_pricing: toBoolSetting(map.get('postnord_use_portal_pricing'), Boolean(config.POSTNORD.usePortalPricing)),
    postnord_enable_transit_time: toBoolSetting(map.get('postnord_enable_transit_time'), Boolean(config.POSTNORD.enableTransitTime)),
    google_client_id: String(map.get('google_client_id') || config.GOOGLE_CLIENT_ID || ''),
  }
}

const ensureSupportMessagesTable = async () => {
  try {
    if (hasSupportMessagesTableCache === true) return

    await db.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        sender_name VARCHAR(100) NOT NULL,
        sender_email VARCHAR(150) NOT NULL,
        sender_role ENUM('guest', 'buyer', 'seller', 'admin') DEFAULT 'guest',
        sender_user_id INT NULL,
        recipient_role ENUM('admin') DEFAULT 'admin',
        subject VARCHAR(120) NOT NULL,
        order_id VARCHAR(40) NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_support_messages_created_at (created_at),
        INDEX idx_support_messages_recipient_role (recipient_role),
        INDEX idx_support_messages_sender_user_id (sender_user_id)
      )
    `)

    hasSupportMessagesTableCache = true
  } catch (error) {
    hasSupportMessagesTableCache = null
    console.error('Failed ensuring support_messages table:', error)
  }
}

const ensureShipmentLabelsTable = async () => {
  try {
    if (hasShipmentLabelsTableCache === true) return

    await db.query(`
      CREATE TABLE IF NOT EXISTS shipment_labels (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        sale_id INT UNSIGNED NULL,
        seller_id INT UNSIGNED NOT NULL,
        order_id VARCHAR(80) NULL,
        booking_id VARCHAR(120) NULL,
        tracking_number VARCHAR(120) NULL,
        label_format VARCHAR(30) NULL,
        mime_type VARCHAR(120) NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size INT UNSIGNED NOT NULL,
        file_url VARCHAR(700) NOT NULL,
        estimated_cost DECIMAL(12,2) NULL,
        estimated_currency VARCHAR(10) NULL,
        provider VARCHAR(40) DEFAULT 'postnord',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_shipment_labels_sale_id (sale_id),
        INDEX idx_shipment_labels_seller_id (seller_id),
        INDEX idx_shipment_labels_tracking_number (tracking_number),
        INDEX idx_shipment_labels_created_at (created_at)
      )
    `)

    hasShipmentLabelsTableCache = true
  } catch (error) {
    hasShipmentLabelsTableCache = null
    console.error('Failed ensuring shipment_labels table:', error)
    throw error
  }
}

let hasDigitalDownloadTokensTableCache: boolean | null = null

const ensureDigitalDownloadTokensTable = async () => {
  try {
    if (hasDigitalDownloadTokensTableCache === true) return

    await db.query(`
      CREATE TABLE IF NOT EXISTS digital_download_tokens (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        token CHAR(36) NOT NULL,
        sale_id INT UNSIGNED NOT NULL,
        product_id INT UNSIGNED NULL,
        variant_id INT UNSIGNED NULL,
        product_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(700) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        download_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        max_downloads TINYINT UNSIGNED NOT NULL DEFAULT 3,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ddt_token (token),
        INDEX idx_ddt_sale_id (sale_id),
        INDEX idx_ddt_customer_email (customer_email)
      )
    `)

    hasDigitalDownloadTokensTableCache = true
  } catch (error) {
    hasDigitalDownloadTokensTableCache = null
    console.error('Failed ensuring digital_download_tokens table:', error)
    throw error
  }
}

const getCommissionSettings = async (): Promise<{ percent: number; fixed: number; promotionPercent: number; rate: number }> => {
  await ensureCommissionSettingsTable()

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT setting_key, setting_value
     FROM app_settings
     WHERE setting_key IN ('platform_commission_percent', 'platform_commission_fixed', 'promotion_commission_percent')`,
  )

  const map = new Map<string, string>()
  for (const row of rows) {
    map.set(String(row.setting_key), String(row.setting_value))
  }

  const percentRaw = Number(map.get('platform_commission_percent'))
  const fixedRaw = Number(map.get('platform_commission_fixed'))
  const promotionPercentRaw = Number(map.get('promotion_commission_percent'))

  const percent = Number.isFinite(percentRaw) && percentRaw >= 0
    ? roundToTwo(percentRaw)
    : DEFAULT_PLATFORM_COMMISSION_PERCENT

  const fixed = Number.isFinite(fixedRaw) && fixedRaw >= 0
    ? roundToTwo(fixedRaw)
    : DEFAULT_PLATFORM_COMMISSION_FIXED

  const promotionPercent = Number.isFinite(promotionPercentRaw) && promotionPercentRaw >= 0
    ? roundToTwo(promotionPercentRaw)
    : DEFAULT_PROMOTION_COMMISSION_PERCENT

  return {
    percent,
    fixed,
    promotionPercent,
    rate: percent / 100,
  }
}

const calculateCommissionAmount = (baseAmount: number, commissionRate: number, commissionFixed: number): number => {
  return roundToTwo(Number(baseAmount || 0) * Number(commissionRate || 0) + Number(commissionFixed || 0))
}

interface OrderProduct {
  product_id?: number
  seller_id: number
  total_price: number
  tax_amount?: number
  quantity: number
  [key: string]: any
}

interface ShipmentFee {
  seller_id?: number
  feeNoVat: number
  vatAmount: number
}

interface CommissionBreakdown {
  totalAmountBeforeCommission: number
  totalTaxAmount: number
  totalShippingAmount: number
  totalGrandAmount: number
  totalCommission: number
  commissionPercent: number
  commissionFixed: number
  sellerBreakdown: {
    seller_id: number
    amountBeforeCommission: number
    taxAmount: number
    shippingAmount: number
    amountBeforeCommissionWithShipping: number
    commissionAmount: number
    amountAfterCommission: number
  }[]
}

/**
 * Calculate total and per-seller commission breakdown
 *
 * @param orderProducts - Array of products grouped or ungrouped, each with seller_id and total_price
 * @param shipmentFees - Map or array of shipment fees by seller_id
 * @param platform_commission_percent - Commission percentage (e.g., 2 for 2%)
 * @param platform_commission_fixed - Commission fixed amount (e.g., 0.5 for 0.5 SEK)
 * @returns Detailed breakdown of commission for total and each seller
 *
 * Formula:
 * - Total commission = (totalAmount) * (platform_commission_percent / 100) + platform_commission_fixed
 * - Commission per seller = Total commission * (seller's share before commission / total amount)
 * - Amount after commission = seller's share before commission - commission for seller
 */
const calculateCommissionBreakdown = (
  orderProducts: OrderProduct[],
  shipmentFees: Map<number, ShipmentFee> | ShipmentFee[] | Record<number, ShipmentFee>,
  platform_commission_percent: number,
  platform_commission_fixed: number,
): CommissionBreakdown => {
  // Convert shipmentFees to Map if needed
  let shipmentFeesMap: Map<number, ShipmentFee>
  if (shipmentFees instanceof Map) {
    shipmentFeesMap = shipmentFees
  } else if (Array.isArray(shipmentFees)) {
    shipmentFeesMap = new Map(
      shipmentFees
        .filter((fee) => Number.isFinite(Number(fee.seller_id)))
        .map((fee) => [Number(fee.seller_id), fee]),
    )
  } else {
    shipmentFeesMap = new Map(Object.entries(shipmentFees).map(([key, value]) => [Number(key), value as ShipmentFee]))
  }

  // Group products by seller
  const sellerData = new Map<number, { products: OrderProduct[]; shippingFee: ShipmentFee | null }>()

  for (const product of orderProducts) {
    const sellerId = product.seller_id
    if (!sellerData.has(sellerId)) {
      sellerData.set(sellerId, {
        products: [],
        shippingFee: shipmentFeesMap.get(sellerId) || null,
      })
    }
    sellerData.get(sellerId)!.products.push(product)
  }

  // Calculate per-seller amounts BEFORE commission
  let totalAmountBeforeCommission = 0
  let totalTaxAmount = 0
  let totalShippingAmount = 0

  const sellerAmounts: {
    seller_id: number
    productTotal: number
    taxAmount: number
    shippingNoVat: number
    shippingVat: number
  }[] = []

  for (const [sellerId, data] of sellerData.entries()) {
    let sellerProductTotal = 0
    let sellerTaxAmount = 0

    for (const product of data.products) {
      const productAmount = Number(product.total_price || 0)
      const productTax = Number(product.tax_amount || 0)
      sellerProductTotal += productAmount
      sellerTaxAmount += productTax
    }

    const shippingNoVat = data.shippingFee?.feeNoVat || 0
    const shippingVat = data.shippingFee?.vatAmount || 0

    totalAmountBeforeCommission += sellerProductTotal
    totalTaxAmount += sellerTaxAmount
    totalShippingAmount += shippingNoVat + shippingVat

    sellerAmounts.push({
      seller_id: sellerId,
      productTotal: sellerProductTotal,
      taxAmount: sellerTaxAmount,
      shippingNoVat: roundToTwo(shippingNoVat),
      shippingVat: roundToTwo(shippingVat),
    })
  }

  // Calculate total amounts
  const totalGrandAmount = roundToTwo(totalAmountBeforeCommission + totalTaxAmount + totalShippingAmount)
  const commissionRate = platform_commission_percent / 100

  // Calculate total commission
  const totalCommission = roundToTwo(totalGrandAmount * commissionRate + platform_commission_fixed)

  // Calculate commission for each seller proportionally
  const sellerBreakdown = sellerAmounts.map((seller) => {
    const sellerAmountWithShipping = roundToTwo(seller.productTotal + seller.taxAmount + seller.shippingNoVat + seller.shippingVat)

    // Seller's proportional share of total commission
    // Commission = TotalCommission * (SellerAmount / TotalAmount)
    const sellerCommission = totalGrandAmount > 0
      ? roundToTwo(totalCommission * (sellerAmountWithShipping / totalGrandAmount))
      : 0

    return {
      seller_id: seller.seller_id,
      amountBeforeCommission: seller.productTotal,
      taxAmount: seller.taxAmount,
      shippingAmount: seller.shippingNoVat + seller.shippingVat,
      amountBeforeCommissionWithShipping: sellerAmountWithShipping,
      commissionAmount: sellerCommission,
      amountAfterCommission: roundToTwo(sellerAmountWithShipping - sellerCommission),
    }
  })

  return {
    totalAmountBeforeCommission,
    totalTaxAmount,
    totalShippingAmount,
    totalGrandAmount,
    totalCommission,
    commissionPercent: platform_commission_percent,
    commissionFixed: platform_commission_fixed,
    sellerBreakdown,
  }
}

const sendCommissionUpdateNotificationToSellers = async (payload: {
  commissionPercent: number
  commissionFixed: number
}) => {
  const [sellerRows] = await db.query<RowDataPacket[]>(
    `SELECT email
     FROM users
     WHERE role = 'seller' AND email IS NOT NULL AND email <> ''`,
  )

  const sellerEmails = Array.from(
    new Set(
      sellerRows
        .map((row) => String(row.email || '').trim())
        .filter((email) => Boolean(email)),
    ),
  )

  if (!sellerEmails.length) {
    return { sent: 0, failed: 0 }
  }

  const subject = 'Platform commission has been updated'
  const html = `
    <div style="font-family: Arial, sans-serif; color:#111827; line-height:1.6;">
      <h2 style="margin:0 0 12px;">Commission Update Notice</h2>
      <p style="margin:0 0 10px;">Hello Seller,</p>
      <p style="margin:0 0 10px;">The platform commission settings have been updated and will apply to new orders.</p>
      <ul style="margin:0 0 12px 18px; padding:0;">
        <li>Commission Percentage: <strong>${payload.commissionPercent.toFixed(2)}%</strong></li>
        <li>Commission Fixed Amount: <strong>${payload.commissionFixed.toFixed(2)} SEK</strong></li>
      </ul>
      <p style="margin:0;">If you have any questions, please contact platform support.</p>
    </div>
  `

  const results = await Promise.allSettled(
    sellerEmails.map((email) => sendEmail(email, subject, html)),
  )

  const sent = results.filter((result) => result.status === 'fulfilled').length
  const failed = results.length - sent
  return { sent, failed }
}

const invoiceTemplatePath = path.join(__dirname, 'email', 'InvoiceCustomer.hbs')
let invoiceTemplateCache: string | null = null

const getInvoiceTemplate = (): string => {
  if (invoiceTemplateCache) return invoiceTemplateCache
  invoiceTemplateCache = fs.readFileSync(invoiceTemplatePath, 'utf8')
  return invoiceTemplateCache
}

const renderTemplate = (template: string, values: Record<string, string>): string => {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] ?? '')
}

const generateGroupOrderId = (): string => {
  const random = Math.random().toString(36).substring(2, 10).toUpperCase()
  return `G-${random}`
}

const generateSellerOrderId = (groupOrderId: string, sellerId: number | string): string => {
  return `${groupOrderId}-S${sellerId}`
}

const generateUniqueProductSku = async (sellerId: number, productName: string): Promise<string> => {
  const baseName = productName
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, 'X')

  for (let attempt = 0; attempt < 8; attempt++) {
    const timePart = Date.now().toString().slice(-6)
    const randomPart = Math.floor(100 + Math.random() * 900)
    const attemptPart = attempt.toString()
    const candidate = `SKU-${baseName}-${sellerId}-${timePart}${attemptPart}${randomPart}`

    const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM products WHERE sku = ? LIMIT 1', [
      candidate,
    ])
    if (existing.length === 0) {
      return candidate
    }
  }

  return `SKU-${baseName}-${sellerId}-${Date.now()}`
}

const generateVariantSku = async (sellerId: number, productName: string, variantValue: string): Promise<string> => {
  const baseName = productName
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, 'X')

  const variantPart = variantValue
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, 'X')

  for (let attempt = 0; attempt < 5; attempt++) {
    const timePart = Date.now().toString().slice(-5)
    const randomPart = Math.floor(10 + Math.random() * 90)
    const attemptPart = attempt.toString()
    const candidate = `VAR-${baseName}-${variantPart}-${sellerId}-${timePart}${attemptPart}${randomPart}`

    const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM product_variants WHERE sku = ? LIMIT 1', [
      candidate,
    ])
    if (existing.length === 0) {
      return candidate
    }
  }

  return `VAR-${baseName}-${variantPart}-${sellerId}-${Date.now()}`
}

type NormalizedVariant = {
  variant_name: string
  variant_value: string
  sku: string | null
  price: number
  discount_price: number | null
  stock_quantity: number
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  weight_kg: number | null
  type: 'digital' | 'physical'
  image_url: string | null
  file_url: string | null
}

const toNullableNumber = (value: any): number | null => {
  if (value === '' || value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseTaxRateFromDbValue = (value: unknown): number => {
  if (value == null) return 0

  const raw = String(value).trim()
  if (!raw) return 0

  const numeric = Number(raw.replace('%', '').trim())
  if (!Number.isFinite(numeric)) return 0

  // Support both stored formats:
  // - "8" or "8%" => 0.08
  // - "0.08" => 0.08
  return numeric > 1 ? numeric / 100 : numeric
}

const roundToTwo = (value: number): number => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100

const normalizeCountryCode = (value: unknown): string => {
  const raw = String(value || '').trim()
  if (!raw) return 'SE'

  if (/^[A-Za-z]{2}$/.test(raw)) {
    return raw.toUpperCase()
  }

  const normalized = raw.toLowerCase()
  const map: Record<string, string> = {
    sweden: 'SE',
    sverige: 'SE',
    norway: 'NO',
    norge: 'NO',
    denmark: 'DK',
    danmark: 'DK',
    finland: 'FI',
    germany: 'DE',
    deutschland: 'DE',
    netherlands: 'NL',
    holland: 'NL',
    france: 'FR',
    italy: 'IT',
    spain: 'ES',
    poland: 'PL',
    unitedkingdom: 'GB',
    'united kingdom': 'GB',
    uk: 'GB',
  }

  return map[normalized] || 'SE'
}

const getSellerSenderAddress = async (sellerId: number): Promise<ShipmentAddressInput> => {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT
      p.first_name,
      p.last_name,
      p.company_name,
      p.street,
      p.city,
      p.zip,
      p.country,
      p.phone,
      u.email
     FROM profiles p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [sellerId],
  )

  const profile = rows[0]
  if (!profile) {
    throw new Error('Seller profile is missing. Please complete your profile address before generating a shipment label.')
  }

  const street = String(profile.street || '').trim()
  const postalCode = String(profile.zip || '').trim()
  const city = String(profile.city || '').trim()
  const countryCode = normalizeCountryCode(profile.country)

  if (!street || !postalCode || !city) {
    throw new Error('Seller address is incomplete. Street, city, and postal code are required to generate a shipment label.')
  }

  const firstName = String(profile.first_name || '').trim()
  const lastName = String(profile.last_name || '').trim()
  const companyName = String(profile.company_name || '').trim()
  const displayName = companyName || `${firstName} ${lastName}`.trim() || 'Seller'

  return {
    name: displayName,
    companyName: companyName || undefined,
    street,
    postalCode,
    city,
    countryCode,
    contactName: `${firstName} ${lastName}`.trim() || displayName,
    emailAddress: String(profile.email || '').trim() || undefined,
    phoneNo: String(profile.phone || '').trim() || undefined,
  }
}

const calculateTaxOnItem = (lineAmount: number, taxRate: number): number => {
  return roundToTwo(Number(lineAmount || 0) * Number(taxRate || 0))
}

const calculateTaxOnShipment = (shipmentFee: number, vatRate: number = VAT_SHIPPING_RATE): number => {
  return roundToTwo(Number(shipmentFee || 0) * Number(vatRate || 0))
}

const calculateNetEarning = (grandTotal: number, totalTax: number, commissionAmount: number): number => {
  return roundToTwo(Number(grandTotal || 0) - Number(totalTax || 0) - Number(commissionAmount || 0))
}

const upsertShipmentLabelExpenseForSale = async (
  saleId: number,
  sellerId: number,
  estimatedCost: number | null,
): Promise<void> => {
  if (!Number.isFinite(saleId) || saleId <= 0) return

  const safeCost = Number.isFinite(Number(estimatedCost)) ? roundToTwo(Math.abs(Number(estimatedCost))) : 0
  const shipmentLabelVatRate = 0.25
  const labelUnitPrice = roundToTwo(-safeCost)
  const labelTax = roundToTwo(labelUnitPrice * shipmentLabelVatRate)

  // Keep only one shipment-label expense row per order, then insert current value.
  await db.query(
    "DELETE FROM sale_items WHERE sale_id = ? AND product_type = 'shipment' AND LOWER(product_name) = 'shipment label'",
    [saleId],
  )

  if (safeCost > 0) {
    await db.query<ResultSetHeader>(
      `INSERT INTO sale_items (
        sale_id, product_type, product_id, product_name, quantity, unit_price, tax_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [saleId, 'shipment', null, 'Shipment Label', 1, labelUnitPrice, labelTax],
    )
  }

  const [salesRows] = await db.query<RowDataPacket[]>(
    'SELECT commission_amount FROM sales WHERE id = ? AND seller_id = ? LIMIT 1',
    [saleId, sellerId],
  )
  if (!salesRows.length) return

  const [sumRows] = await db.query<RowDataPacket[]>(
    `SELECT
      COALESCE(SUM(unit_price * quantity), 0) AS subtotal,
      COALESCE(SUM(tax_amount), 0) AS tax_total
     FROM sale_items
     WHERE sale_id = ?`,
    [saleId],
  )

  const subtotal = Number(sumRows[0]?.subtotal || 0)
  const taxTotal = Number(sumRows[0]?.tax_total || 0)
  const nextGrandTotal = roundToTwo(subtotal + taxTotal)
  const commissionAmount = Number(salesRows[0]?.commission_amount || 0)

  await db.query(
    'UPDATE sales SET tax_amount = ?, grand_total = ?, commission_amount = ? WHERE id = ? AND seller_id = ?',
    [taxTotal, nextGrandTotal, commissionAmount, saleId, sellerId],
  )
}

const resolveOrderStatusFromTracking = (tracked: {
  status?: string | null
  statusDescription?: string | null
  events?: Array<{ status?: string | null; description?: string | null }>
}): 'processing' | 'shipped' | 'delivered' | 'returned' | 'cancelled' => {
  const chunks = [
    String(tracked.status || ''),
    String(tracked.statusDescription || ''),
    ...(tracked.events || []).flatMap((evt) => [String(evt.status || ''), String(evt.description || '')]),
  ]
    .join(' ')
    .toLowerCase()

  if (/delivered|utdelad|levererad|received by recipient/.test(chunks)) return 'delivered'
  if (/return|returned|retur|avsändare/.test(chunks)) return 'returned'
  if (/cancel|cancelled|annullerad/.test(chunks)) return 'cancelled'
  if (/in transit|transport|on the way|under delivery|dispatched|shipped/.test(chunks)) return 'shipped'
  return 'processing'
}

const normalizeVariantsFromRequest = (
  rawVariants: any,
  defaults: { price?: any; discount_price?: any; stock_quantity?: any; type?: any },
): NormalizedVariant[] => {
  let parsed = rawVariants

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = []
    }
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.variants)) {
    parsed = parsed.variants
  }

  if (!Array.isArray(parsed)) return []

  const result: NormalizedVariant[] = []

  for (const variant of parsed) {
    const variantName = String(variant?.className || variant?.variant_name || variant?.variantName || 'Default').trim() || 'Default'

    if (Array.isArray(variant?.values)) {
      for (const valueEntry of variant.values) {
        const variantValue = typeof valueEntry === 'string'
          ? valueEntry
          : String(valueEntry?.value || valueEntry?.name || valueEntry?.variant_value || '').trim()

        if (!variantValue) continue

        const price = Number(
          (typeof valueEntry === 'object' && valueEntry?.price != null ? valueEntry.price : defaults.price) ?? 0,
        )
        const safePrice = Number.isFinite(price) ? price : 0

        const stockRaw = typeof valueEntry === 'object' && valueEntry?.stock != null
          ? valueEntry.stock
          : (typeof valueEntry === 'object' && valueEntry?.stock_quantity != null ? valueEntry.stock_quantity : defaults.stock_quantity)
        const stockParsed = Number(stockRaw ?? 0)

        result.push({
          variant_name: variantName,
          variant_value: variantValue,
          sku: typeof valueEntry === 'object' && valueEntry?.sku ? String(valueEntry.sku) : null,
          price: safePrice,
          discount_price: toNullableNumber(typeof valueEntry === 'object' ? valueEntry?.discount_price : defaults.discount_price),
          stock_quantity: Number.isFinite(stockParsed) && stockParsed > 0 ? Math.floor(stockParsed) : 0,
          length_cm: toNullableNumber(typeof valueEntry === 'object' ? valueEntry?.length : null),
          width_cm: toNullableNumber(typeof valueEntry === 'object' ? valueEntry?.width : null),
          height_cm: toNullableNumber(typeof valueEntry === 'object' ? valueEntry?.height : null),
          weight_kg: toNullableNumber(typeof valueEntry === 'object' ? valueEntry?.weight : null),
          type: ((typeof valueEntry === 'object' ? valueEntry?.type : defaults.type) === 'digital') ? 'digital' : 'physical',
          image_url: typeof valueEntry === 'object' && valueEntry?.image ? String(valueEntry.image) : null,
          file_url: typeof valueEntry === 'object' && valueEntry?.file ? String(valueEntry.file) : null,
        })
      }
      continue
    }

    const flatValue = String(variant?.variant_value || variant?.value || '').trim()
    if (!flatValue) continue
    const flatPrice = Number(variant?.price ?? defaults.price ?? 0)
    const flatStock = Number(variant?.stock_quantity ?? defaults.stock_quantity ?? 0)

    result.push({
      variant_name: variantName,
      variant_value: flatValue,
      sku: variant?.sku ? String(variant.sku) : null,
      price: Number.isFinite(flatPrice) ? flatPrice : 0,
      discount_price: toNullableNumber(variant?.discount_price ?? defaults.discount_price),
      stock_quantity: Number.isFinite(flatStock) && flatStock > 0 ? Math.floor(flatStock) : 0,
      length_cm: toNullableNumber(variant?.length_cm),
      width_cm: toNullableNumber(variant?.width_cm),
      height_cm: toNullableNumber(variant?.height_cm),
      weight_kg: toNullableNumber(variant?.weight_kg),
      type: (variant?.type === 'digital' || defaults.type === 'digital') ? 'digital' : 'physical',
      image_url: variant?.image_url || null,
      file_url: variant?.file_url || null,
    })
  }

  return result
}

// ===== Rate limiter for login/register =====
const loginRateLimiter: Map<string, number[]> = new Map()
const isAuthRateLimitDisabled = config.DISABLE_AUTH_RATE_LIMIT

const checkLoginRateLimit = (ip: string): boolean => {
  if (isAuthRateLimitDisabled) {
    return true
  }

  const now = Date.now()
  const MAX_ATTEMPTS = 5
  const TIME_WINDOW = 15 * 60 * 1000 // 15 minutes

  let timestamps = loginRateLimiter.get(ip) || []
  timestamps = timestamps.filter(t => now - t < TIME_WINDOW)

  if (timestamps.length >= MAX_ATTEMPTS) {
    return false // Rate limited
  }

  timestamps.push(now)
  loginRateLimiter.set(ip, timestamps)
  return true
}

// Cleanup old rate limit entries every hour
setInterval(() => {
  const now = Date.now()
  const TIME_WINDOW = 15 * 60 * 1000
  for (const [ip, timestamps] of loginRateLimiter.entries()) {
    const active = timestamps.filter(t => now - t < TIME_WINDOW)
    if (active.length === 0) {
      loginRateLimiter.delete(ip)
    } else {
      loginRateLimiter.set(ip, active)
    }
  }
}, 60 * 60 * 1000)

const getServerBaseUrl = (req: Request): string => {
  if (config.BACKEND_PUBLIC_BASE_URL) {
    return config.BACKEND_PUBLIC_BASE_URL.replace(/\/+$/, '')
  }

  const rawForwardedProto = req.headers['x-forwarded-proto']
  const forwardedProto = Array.isArray(rawForwardedProto)
    ? rawForwardedProto[0]
    : String(rawForwardedProto || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'http'
  const host = req.get('host') || ''
  if (!host) {
    throw new Error('Cannot resolve server host. Set BACKEND_PUBLIC_BASE_URL in environment.')
  }
  return `${protocol}://${host}`
}

const createSellerVerificationEmailHtml = (verificationUrl: string): string => {
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;">
    <h2 style="margin:0 0 12px;">Verify your seller email</h2>
    <p style="margin:0 0 12px;line-height:1.5;">Thanks for signing up. Verify your email address before logging in.</p>
    <p style="margin:0 0 20px;line-height:1.5;">Click the button below to verify your account:</p>
    <a href="${verificationUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Verify Email</a>
    <p style="margin:20px 0 8px;line-height:1.5;font-size:13px;color:#4b5563;">If the button does not work, open this link:</p>
    <p style="margin:0;word-break:break-all;font-size:13px;color:#1f2937;">${verificationUrl}</p>
  </div>`
}

const createSellerPasswordResetEmailHtml = (resetUrl: string): string => {
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;">
    <h2 style="margin:0 0 12px;">Reset your seller password</h2>
    <p style="margin:0 0 12px;line-height:1.5;">We received a request to reset the password for your seller account.</p>
    <p style="margin:0 0 20px;line-height:1.5;">Click the button below to set a new password. This link expires in 1 hour.</p>
    <a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Reset Password</a>
    <p style="margin:20px 0 8px;line-height:1.5;font-size:13px;color:#4b5563;">If the button does not work, open this link:</p>
    <p style="margin:0;word-break:break-all;font-size:13px;color:#1f2937;">${resetUrl}</p>
    <p style="margin:20px 0 0;line-height:1.5;font-size:13px;color:#6b7280;">If you did not request this change, you can safely ignore this email.</p>
  </div>`
}

const trimEmail = (value: unknown): string => String(value || '').trim().toLowerCase()

const createAuthCaptchaChallenge = () => {
  const left = Math.floor(Math.random() * 8) + 2
  const right = Math.floor(Math.random() * 8) + 1
  const challengeId = crypto.randomUUID()
  authCaptchaChallenges.set(challengeId, {
    answer: String(left + right),
    expiresAt: Date.now() + AUTH_CAPTCHA_TTL_MS,
  })

  return {
    challengeId,
    prompt: `What is ${left} + ${right}?`,
  }
}

const validateAuthCaptchaChallenge = (challengeId: string, captchaAnswer: string): boolean => {
  const challenge = authCaptchaChallenges.get(challengeId)
  authCaptchaChallenges.delete(challengeId)

  if (!challenge) return false
  if (Date.now() > challenge.expiresAt) return false

  return challenge.answer === String(captchaAnswer || '').trim()
}

const hashToken = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

const issueAuthToken = (userId: number): string => {
  return jwt.sign({ id: userId }, config.JWT_SECRET, {
    expiresIn: '24h',
  })
}

const getGoogleUserPayload = async (credential: string) => {
  const googleClientId = String(process.env.GOOGLE_CLIENT_ID || config.GOOGLE_CLIENT_ID || '').trim()
  if (!googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured')
  }

  const googleAuthClient = new OAuth2Client(googleClientId)

  const ticket = await googleAuthClient.verifyIdToken({
    idToken: credential,
    audience: googleClientId,
  })

  return ticket.getPayload()
}

// ===== Register Route =====
app.post('/api/register', async (req: Request, res: Response) => {
  const clientIp = String(req.ip || 'unknown')

  // Rate limiting
  if (!checkLoginRateLimit(clientIp)) {
    return res.status(429).json({ message: 'Too many registration attempts. Please try again later.' })
  }

  const email = trimEmail(req.body?.email)
  const password = String(req.body?.password || '')

  if (!email || !password) {
    return res.status(400).json({ message: 'All fields are required' })
  }

  try {
    await ensureEmailVerificationColumns()

    // Use SELECT with specific columns instead of SELECT *
    const [existing] = await db.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [email]

    )

    if (existing.length > 0) {
      return res.status(400).json({ message: 'User already exists' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const verificationToken = crypto.randomBytes(32).toString('hex')

    const [result] = await db.query<ResultSetHeader>(
      'INSERT INTO users (email, password, role, email_is_verified, email_verification_token) VALUES (?, ?, ?, ?, ?)',
      [email, hashedPassword, 'seller', false, verificationToken],
    )

    const verifyUrl = `${getServerBaseUrl(req)}/api/email/verify?token=${verificationToken}`
    await sendEmail(
      String(email),
      'Verify your seller account email',
      createSellerVerificationEmailHtml(verifyUrl),
    )

    res.status(201).json({
      id: result.insertId,
      email,
      role: 'seller',
      requires_email_verification: true,
      message: 'Registration successful. Please verify your email before logging in.',
    })
  } catch (err) {
    console.error('Registration error:', err)
    // Return generic error without exposing details
    res.status(500).json({ message: 'Registration failed. Please try again.' })
  }
})

app.get('/api/email/verify', async (req: Request, res: Response) => {
  const token = String(req.query?.token || '').trim()
  const signinUrl = `${String(config.CLIENT_URL).replace(/\/$/, '')}/signin`

  if (!token) {
    return res.redirect(`${signinUrl}?emailVerified=0&reason=invalid-link`)
  }

  try {
    await ensureEmailVerificationColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT id, email, role, email_is_verified FROM users WHERE email_verification_token = ? LIMIT 1',
      [token],
    )

    if (!rows.length) {
      return res.redirect(`${signinUrl}?emailVerified=0&reason=invalid-token`)
    }

    const user = rows[0]
    if (String(user.role || '') !== 'seller') {
      return res.redirect(`${signinUrl}?emailVerified=0&reason=not-seller`)
    }

    if (Boolean(user.email_is_verified)) {
      return res.redirect(`${signinUrl}?emailVerified=1&already=1`)
    }

    await db.query(
      'UPDATE users SET email_is_verified = TRUE, email_verification_token = NULL WHERE id = ? LIMIT 1',
      [user.id],
    )

    return res.redirect(`${signinUrl}?emailVerified=1`)
  } catch (error) {
    console.error('Email verification error:', error)
    return res.redirect(`${signinUrl}?emailVerified=0&reason=server-error`)
  }
})

app.get('/api/auth/captcha', (_req: Request, res: Response) => {
  return res.json(createAuthCaptchaChallenge())
})

app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const email = trimEmail(req.body?.email)

  if (!email) {
    return res.status(400).json({ message: 'Email is required' })
  }

  try {
    await ensurePasswordResetColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT id, email FROM users WHERE LOWER(email) = LOWER(?) AND role = 'seller' LIMIT 1",
      [email],
    )

    if (rows.length > 0) {
      const user = rows[0]
      const rawToken = crypto.randomBytes(32).toString('hex')
      const tokenHash = hashToken(rawToken)
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS)
      const resetUrl = `${String(config.CLIENT_URL).replace(/\/$/, '')}/reset-password?token=${rawToken}`

      await db.query(
        'UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ? LIMIT 1',
        [tokenHash, expiresAt, user.id],
      )

      await sendEmail(
        String(user.email),
        'Reset your seller account password',
        createSellerPasswordResetEmailHtml(resetUrl),
      )
    }

    return res.json({
      message: 'If the seller account exists, a password reset email has been sent.',
    })
  } catch (error) {
    console.error('Forgot password error:', error)
    return res.status(500).json({ message: 'Failed to process password reset request.' })
  }
})

app.get('/api/auth/reset-password/validate', async (req: Request, res: Response) => {
  const rawToken = String(req.query?.token || '').trim()

  if (!rawToken) {
    return res.status(400).json({ valid: false, message: 'Reset token is required.' })
  }

  try {
    await ensurePasswordResetColumns()
    const tokenHash = hashToken(rawToken)
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at IS NOT NULL AND password_reset_expires_at > NOW() LIMIT 1',
      [tokenHash],
    )

    return res.json({ valid: rows.length > 0 })
  } catch (error) {
    console.error('Reset password validate error:', error)
    return res.status(500).json({ valid: false, message: 'Failed to validate reset token.' })
  }
})

app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  const rawToken = String(req.body?.token || '').trim()
  const password = String(req.body?.password || '')

  if (!rawToken || !password) {
    return res.status(400).json({ message: 'Token and password are required.' })
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' })
  }

  try {
    await ensurePasswordResetColumns()
    const tokenHash = hashToken(rawToken)
    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at IS NOT NULL AND password_reset_expires_at > NOW() LIMIT 1',
      [tokenHash],
    )

    if (!rows.length) {
      return res.status(400).json({ message: 'Reset link is invalid or expired.' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    await db.query(
      'UPDATE users SET password = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = ? LIMIT 1',
      [hashedPassword, rows[0].id],
    )

    return res.json({ message: 'Password updated successfully. You can now sign in.' })
  } catch (error) {
    console.error('Reset password error:', error)
    return res.status(500).json({ message: 'Failed to reset password.' })
  }
})

app.post('/api/auth/google', async (req: Request, res: Response) => {
  const credential = String(req.body?.credential || '').trim()

  if (!credential) {
    return res.status(400).json({ message: 'Google credential is required.' })
  }

  try {
    await ensureEmailVerificationColumns()
    await ensureGoogleAuthColumns()

    const payload = await getGoogleUserPayload(credential)
    const email = trimEmail(payload?.email)
    const googleSub = String(payload?.sub || '').trim()

    if (!email || !googleSub || !payload?.email_verified) {
      return res.status(400).json({ message: 'Google account email is not verified.' })
    }

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE google_sub = ? OR LOWER(email) = LOWER(?) ORDER BY CASE WHEN google_sub = ? THEN 0 ELSE 1 END LIMIT 1',
      [googleSub, email, googleSub],
    )

    let user = rows[0]

    if (!user) {
      const generatedPassword = crypto.randomBytes(32).toString('hex')
      const hashedPassword = await bcrypt.hash(generatedPassword, 10)
      const [result] = await db.query<ResultSetHeader>(
        'INSERT INTO users (email, password, role, email_is_verified, google_sub) VALUES (?, ?, ?, ?, ?)',
        [email, hashedPassword, 'seller', true, googleSub],
      )

      const [freshRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM users WHERE id = ? LIMIT 1',
        [result.insertId],
      )
      user = freshRows[0]
    } else if (String(user.google_sub || '').trim() !== googleSub || !Boolean(user.email_is_verified)) {
      await db.query(
        'UPDATE users SET google_sub = ?, email_is_verified = TRUE, email_verification_token = NULL WHERE id = ? LIMIT 1',
        [googleSub, user.id],
      )

      const [freshRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM users WHERE id = ? LIMIT 1',
        [user.id],
      )
      user = freshRows[0]
    }

    const token = issueAuthToken(Number(user.id))
    return res.json({
      message: 'Google authentication successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    console.error('Google auth error:', error)
    return res.status(400).json({ message: 'Google authentication failed.' })
  }
})

// ===== Login Route =====
app.post('/api/login', async (req: Request, res: Response) => {
  const clientIp = String(req.ip || 'unknown')

  // Rate limiting
  if (!checkLoginRateLimit(clientIp)) {
    return res.status(429).json({ message: 'Too many login attempts. Please try again later.' })
  }
  const email = trimEmail(req.body?.email)
  const password = String(req.body?.password || '')
  const otp = String(req.body?.otp || '').trim()
  const captchaChallengeId = String(req.body?.captchaChallengeId || '').trim()
  const captchaAnswer = String(req.body?.captchaAnswer || '').trim()

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' })
  }

  if (!otp) {
    if (!captchaChallengeId || !captchaAnswer) {
      return res.status(400).json({ message: 'Please complete the human check before signing in.' })
    }

    if (!validateAuthCaptchaChallenge(captchaChallengeId, captchaAnswer)) {
      return res.status(400).json({ message: 'Human check failed. Please try again with a new challenge.' })
    }
  }

  try {
    await ensureTwoFaColumns()
    await ensureEmailVerificationColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]

    )

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Invalid credentials' })
    }

    const user = rows[0]
    const match = await bcrypt.compare(password, user.password)

    if (!match) {
      return res.status(400).json({ message: 'Invalid credentials' })
    }

    if (String(user.role || '') === 'seller' && !Boolean(user.email_is_verified)) {
      return res.status(403).json({
        message: 'Please verify your email before logging in.',
        requires_email_verification: true,
      })
    }

    const isTwoFaEnabled = Boolean(user.is_2fa_enabled)
    const twoFaSecret = String(user.twofa_secret || '').trim()

    if (isTwoFaEnabled) {
      if (!otp) {
        return res.status(401).json({
          message: 'Two-factor authentication code required',
          requires_2fa: true,
        })
      }

      if (!/^\d{6}$/.test(otp)) {
        return res.status(400).json({
          message: 'Enter a valid 6-digit authenticator code',
          requires_2fa: true,
        })
      }

      if (!twoFaSecret) {
        return res.status(400).json({
          message: '2FA is enabled but not configured correctly. Please contact support.',
          requires_2fa: true,
        })
      }

      const verification = await verify({ token: otp, secret: twoFaSecret })
      if (!verification.valid) {
        return res.status(400).json({
          message: 'Invalid authenticator code',
          requires_2fa: true,
        })
      }
    }

    const token = issueAuthToken(Number(user.id))

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

app.get('/api/settings/2fa/status', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureTwoFaColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT is_2fa_enabled FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found' })
    }

    return res.json({ enabled: Boolean(rows[0].is_2fa_enabled) })
  } catch (error) {
    console.error('2FA status error:', error)
    return res.status(500).json({ message: 'Failed to fetch 2FA status' })
  }
})

app.post('/api/settings/2fa/setup', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureTwoFaColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT email, is_2fa_enabled FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found' })
    }

    const user = rows[0]
    if (Boolean(user.is_2fa_enabled)) {
      return res.status(400).json({ message: '2FA is already enabled.' })
    }

    const secret = generateSecret()
    const otpauth = generateURI({
      issuer: 'ShopHub Seller',
      label: String(user.email),
      secret,
    })
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth)

    pendingTwoFaSecrets.set(auth.id, {
      secret,
      expiresAt: Date.now() + TWO_FA_SETUP_TTL_MS,
    })

    return res.json({
      secret,
      otpauth,
      qrCodeDataUrl,
      expiresInSeconds: Math.floor(TWO_FA_SETUP_TTL_MS / 1000),
    })
  } catch (error) {
    console.error('2FA setup error:', error)
    return res.status(500).json({ message: 'Failed to start 2FA setup' })
  }
})

app.post('/api/settings/2fa/enable', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const token = String(req.body?.token || '').trim()
  if (!/^\d{6}$/.test(token)) {
    return res.status(400).json({ message: 'Valid 6-digit authenticator code is required.' })
  }

  try {
    await ensureTwoFaColumns()

    const pending = pendingTwoFaSecrets.get(auth.id)
    if (!pending || pending.expiresAt < Date.now()) {
      pendingTwoFaSecrets.delete(auth.id)
      return res.status(400).json({ message: '2FA setup session expired. Please generate a new QR code.' })
    }

    const verification = await verify({ token, secret: pending.secret })
    if (!verification.valid) {
      return res.status(400).json({ message: 'Invalid authenticator code.' })
    }

    await db.query(
      'UPDATE users SET is_2fa_enabled = 1, twofa_secret = ? WHERE id = ?',
      [pending.secret, auth.id],
    )

    pendingTwoFaSecrets.delete(auth.id)
    return res.json({ success: true, message: '2FA enabled successfully.' })
  } catch (error) {
    console.error('2FA enable error:', error)
    return res.status(500).json({ message: 'Failed to enable 2FA' })
  }
})

app.post('/api/settings/2fa/disable', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const token = String(req.body?.token || '').trim()
  if (!/^\d{6}$/.test(token)) {
    return res.status(400).json({ message: 'Valid 6-digit authenticator code is required.' })
  }

  try {
    await ensureTwoFaColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT is_2fa_enabled, twofa_secret FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found' })
    }

    const user = rows[0]
    if (!Boolean(user.is_2fa_enabled) || !String(user.twofa_secret || '').trim()) {
      return res.status(400).json({ message: '2FA is not enabled.' })
    }

    const verification = await verify({ token, secret: String(user.twofa_secret) })
    if (!verification.valid) {
      return res.status(400).json({ message: 'Invalid authenticator code.' })
    }

    await db.query(
      'UPDATE users SET is_2fa_enabled = 0, twofa_secret = NULL WHERE id = ?',
      [auth.id],
    )

    pendingTwoFaSecrets.delete(auth.id)
    return res.json({ success: true, message: '2FA disabled successfully.' })
  } catch (error) {
    console.error('2FA disable error:', error)
    return res.status(500).json({ message: 'Failed to disable 2FA' })
  }
})

app.get('/api/settings/preferences', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureUserPreferenceColumns()

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         notify_order_received,
         notify_payment_received,
         notify_feedback_received,
         notify_admin_message,
         notify_product_approved,
         preferred_theme
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [auth.id],
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found' })
    }

    const row = rows[0]
    return res.json({
      notify_order_received: Boolean(row.notify_order_received),
      notify_payment_received: Boolean(row.notify_payment_received),
      notify_feedback_received: Boolean(row.notify_feedback_received),
      notify_admin_message: Boolean(row.notify_admin_message),
      notify_product_approved: Boolean(row.notify_product_approved),
      preferred_theme: row.preferred_theme === 'dark' ? 'dark' : 'light',
    })
  } catch (error) {
    console.error('Settings preferences read error:', error)
    return res.status(500).json({ message: 'Failed to load settings preferences' })
  }
})

app.put('/api/settings/preferences', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureUserPreferenceColumns()

    const payload = req.body || {}

    const notifyOrderReceived = Boolean(payload.notify_order_received)
    const notifyPaymentReceived = Boolean(payload.notify_payment_received)
    const notifyFeedbackReceived = Boolean(payload.notify_feedback_received)
    const notifyAdminMessage = Boolean(payload.notify_admin_message)
    const notifyProductApproved = Boolean(payload.notify_product_approved)
    const preferredTheme = payload.preferred_theme === 'dark' ? 'dark' : 'light'

    await db.query(
      `UPDATE users
       SET
         notify_order_received = ?,
         notify_payment_received = ?,
         notify_feedback_received = ?,
         notify_admin_message = ?,
         notify_product_approved = ?,
         preferred_theme = ?
       WHERE id = ?`,
      [
        notifyOrderReceived,
        notifyPaymentReceived,
        notifyFeedbackReceived,
        notifyAdminMessage,
        notifyProductApproved,
        preferredTheme,
        auth.id,
      ],
    )

    return res.json({
      success: true,
      message: 'Settings updated successfully.',
      preferences: {
        notify_order_received: notifyOrderReceived,
        notify_payment_received: notifyPaymentReceived,
        notify_feedback_received: notifyFeedbackReceived,
        notify_admin_message: notifyAdminMessage,
        notify_product_approved: notifyProductApproved,
        preferred_theme: preferredTheme,
      },
    })
  } catch (error) {
    console.error('Settings preferences update error:', error)
    return res.status(500).json({ message: 'Failed to update settings preferences' })
  }
})

app.get('/api/admin/settings/commission', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const settings = await getCommissionSettings()
    return res.json({
      commission_percent: settings.percent,
      commission_fixed: settings.fixed,
      promotion_commission_percent: settings.promotionPercent,
    })
  } catch (error) {
    console.error('Admin commission settings read error:', error)
    return res.status(500).json({ message: 'Failed to load commission settings' })
  }
})

app.put('/api/admin/settings/commission', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const percentRaw = Number(req.body?.commission_percent)
  const fixedRaw = Number(req.body?.commission_fixed)
  const promotionPercentRaw = Number(req.body?.promotion_commission_percent)

  if (!Number.isFinite(percentRaw) || percentRaw < 0 || percentRaw > 100) {
    return res.status(400).json({ message: 'commission_percent must be a number between 0 and 100' })
  }

  if (!Number.isFinite(fixedRaw) || fixedRaw < 0) {
    return res.status(400).json({ message: 'commission_fixed must be a non-negative number' })
  }

  if (!Number.isFinite(promotionPercentRaw) || promotionPercentRaw < 0 || promotionPercentRaw > 100) {
    return res.status(400).json({ message: 'promotion_commission_percent must be a number between 0 and 100' })
  }

  const commissionPercent = roundToTwo(percentRaw)
  const commissionFixed = roundToTwo(fixedRaw)
  const promotionCommissionPercent = roundToTwo(promotionPercentRaw)

  try {
    await ensureCommissionSettingsTable()

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('platform_commission_percent', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [String(commissionPercent)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('platform_commission_fixed', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [String(commissionFixed)],
    )

    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES ('promotion_commission_percent', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [String(promotionCommissionPercent)],
    )

    const emailResult = await sendCommissionUpdateNotificationToSellers({
      commissionPercent,
      commissionFixed,
    })

    return res.json({
      success: true,
      message: 'Commission settings updated successfully.',
      commission_percent: commissionPercent,
      commission_fixed: commissionFixed,
      promotion_commission_percent: promotionCommissionPercent,
      seller_notification: {
        sent: emailResult.sent,
        failed: emailResult.failed,
      },
    })
  } catch (error) {
    console.error('Admin commission settings update error:', error)
    return res.status(500).json({ message: 'Failed to update commission settings' })
  }
})

app.get('/api/admin/settings/runtime', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const settings = await getRuntimeSettings()
    applyRuntimeSettings(settings)
    return res.json(settings)
  } catch (error) {
    console.error('Admin runtime settings read error:', error)
    return res.status(500).json({ message: 'Failed to load runtime settings' })
  }
})

app.put('/api/admin/settings/runtime', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const payload = req.body || {}
  const vatShippingRate = Number(payload.vat_shipping_rate)
  if (!Number.isFinite(vatShippingRate) || vatShippingRate < 0 || vatShippingRate > 1) {
    return res.status(400).json({ message: 'vat_shipping_rate must be between 0 and 1' })
  }

  try {
    await ensureCommissionSettingsTable()

    const values: Array<[string, string]> = [
      ['vat_shipping_rate', String(vatShippingRate)],
      ['email_address', String(payload.email_address || '').trim()],
      ['email_company_name', String(payload.email_company_name || '').trim()],
      ['email_company_address', String(payload.email_company_address || '').trim()],
      ['email_company_logo_url', String(payload.email_company_logo_url || '').trim()],
      ['email_use_test_receiver', String(Boolean(payload.email_use_test_receiver))],
      ['email_test_receiver', String(payload.email_test_receiver || '').trim()],
      ['company_organization_number', String(payload.company_organization_number || '').trim()],
      ['postnord_customer_number', String(payload.postnord_customer_number || '').trim()],
      ['postnord_debug_logs', String(Boolean(payload.postnord_debug_logs))],
      ['postnord_use_portal_pricing', String(Boolean(payload.postnord_use_portal_pricing))],
      ['postnord_enable_transit_time', String(Boolean(payload.postnord_enable_transit_time))],
      ['google_client_id', String(payload.google_client_id || '').trim()],
    ]

    for (const [key, value] of values) {
      await db.query(
        `INSERT INTO app_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value],
      )
    }

    const settings = await getRuntimeSettings()
    applyRuntimeSettings(settings)
    return res.json({ success: true, settings })
  } catch (error) {
    console.error('Admin runtime settings update error:', error)
    return res.status(500).json({ message: 'Failed to update runtime settings' })
  }
})

// ===== Protected Route =====
app.get('/api/profile', async (req: Request, res: Response) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) return res.status(401).json({ message: 'Access denied' })

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthPayload
    res.json({ message: 'Profile info', user: decoded })
  } catch (err) {
    res.status(403).json({ message: 'Invalid token' })
  }
})

app.get('/api/notifications/summary', async (req: Request, res: Response) => {
  const auth = await requireSellerOrAdmin(req, res)
  if (!auth) return

  const sinceRaw = String(req.query.since || '').trim()
  const parsedSince = sinceRaw ? new Date(sinceRaw) : null
  const sinceSql = parsedSince && !Number.isNaN(parsedSince.getTime())
    ? parsedSince.toISOString().slice(0, 19).replace('T', ' ')
    : null

  try {
    if (auth.role === 'admin') {
      await ensureSupportMessagesTable()

      const [sellerCountRows] = await db.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, MAX(created_at) AS latest_at
         FROM users
         WHERE role = 'seller'
         ${sinceSql ? 'AND created_at > ?' : ''}`,
        sinceSql ? [sinceSql] : [],
      )

      const [orderCountRows] = await db.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, MAX(created_at) AS latest_at
         FROM sales
         ${sinceSql ? 'WHERE created_at > ?' : ''}`,
        sinceSql ? [sinceSql] : [],
      )

      const [messageCountRows] = await db.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total, MAX(created_at) AS latest_at
         FROM support_messages
         WHERE recipient_role = 'admin'
         ${sinceSql ? 'AND created_at > ?' : ''}`,
        sinceSql ? [sinceSql] : [],
      )

      const newSellers = Number(sellerCountRows[0]?.total || 0)
      const newOrders = Number(orderCountRows[0]?.total || 0)
      const newMessages = Number(messageCountRows[0]?.total || 0)

      const items = [
        {
          id: 'admin-new-sellers',
          title: 'New sellers',
          description: newSellers > 0
            ? `${newSellers} new seller${newSellers === 1 ? '' : 's'} registered since your last check.`
            : 'No new sellers since your last check.',
          count: newSellers,
          href: '/sellers-admin',
          tone: 'info',
          created_at: sellerCountRows[0]?.latest_at || null,
        },
        {
          id: 'admin-new-orders',
          title: 'New orders',
          description: newOrders > 0
            ? `${newOrders} new order${newOrders === 1 ? '' : 's'} need review.`
            : 'No new orders since your last check.',
          count: newOrders,
          href: '/orders-admin',
          tone: 'success',
          created_at: orderCountRows[0]?.latest_at || null,
        },
        {
          id: 'admin-new-messages',
          title: 'New messages',
          description: newMessages > 0
            ? `${newMessages} new support message${newMessages === 1 ? '' : 's'} received.`
            : 'No new support messages since your last check.',
          count: newMessages,
          href: '/admin-portal',
          tone: 'warning',
          created_at: messageCountRows[0]?.latest_at || null,
        },
      ]

      return res.status(200).json({
        role: auth.role,
        unread_count: items.reduce((sum, item) => sum + item.count, 0),
        items,
      })
    }

    await ensureSalesPayoutColumns()
    await ensureBankAccountsTable()
    await ensureProfilesBlockColumns()

    const [orderCountRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, MAX(created_at) AS latest_at
       FROM sales
       WHERE seller_id = ?
       ${sinceSql ? 'AND created_at > ?' : ''}`,
      sinceSql ? [auth.id, sinceSql] : [auth.id],
    )

    const payoutDateExpression = await hasSalesPayoutPaymentDateColumn()
      ? 'COALESCE(payout_payment_date, updated_at)'
      : 'updated_at'

    const [payoutCountRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, MAX(${payoutDateExpression}) AS latest_at
       FROM sales
       WHERE seller_id = ?
         AND payout_status = 'paid'
       ${sinceSql ? `AND ${payoutDateExpression} > ?` : ''}`,
      sinceSql ? [auth.id, sinceSql] : [auth.id],
    )

    const profileTimestampExpression = await hasProfilesUpdatedAtColumn()
      ? 'updated_at'
      : 'created_at'

    const [profileStatusRows] = await db.query<RowDataPacket[]>(
      `SELECT
        COALESCE(status, 'pending') AS status,
        COALESCE(status_reason, '') AS status_reason,
        COALESCE(${profileTimestampExpression}, created_at) AS status_updated_at
      FROM profiles
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
      [auth.id],
    )

    const hasRejectionMessage = await hasProductRejectionMessageColumn()
    const rejectionMessageExpression = hasRejectionMessage
      ? "COALESCE(rejection_message, '')"
      : "''"

    const [productNoticeRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, MAX(updated_at) AS latest_at
       FROM products
       WHERE seller_id = ?
         AND (approval_status = 'rejected' OR ${rejectionMessageExpression} <> '')
       ${sinceSql ? 'AND updated_at > ?' : ''}`,
      sinceSql ? [auth.id, sinceSql] : [auth.id],
    )

    const hasProfileCompanyAddress = await hasProfilesCompanyAddressColumn()
    const companyAddressSelect = hasProfileCompanyAddress
      ? 'company_address'
      : 'NULL AS company_address'

    const [profileRows] = await db.query<RowDataPacket[]>(
      `SELECT
        first_name,
        last_name,
        street,
        city,
        country,
        zip,
        phone,
        profile_type,
        company_name,
        company_org_number,
        company_vat_number,
        ${companyAddressSelect}
      FROM profiles
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
      [auth.id],
    )

    const [bankRows] = await db.query<RowDataPacket[]>(
      `SELECT
        account_country,
        account_holder_type,
        routing_code,
        account_number_iban,
        company_bank_type,
        bank_name
      FROM bank_accounts
      WHERE user_id = ?
      LIMIT 1`,
      [auth.id],
    )

    const profile = profileRows[0] || null
    const bank = bankRows[0] || null
    const missingFields: string[] = []

    if (!profile) {
      missingFields.push('profile')
    } else {
      if (!profile.first_name) missingFields.push('first name')
      if (!profile.last_name) missingFields.push('last name')
      if (!profile.street) missingFields.push('street')
      if (!profile.city) missingFields.push('city')
      if (!profile.country) missingFields.push('country')
      if (!profile.zip) missingFields.push('zip')
      if (!profile.phone) missingFields.push('phone')
      if (!profile.profile_type) missingFields.push('profile type')

      if (profile.profile_type === 'company') {
        if (!profile.company_name) missingFields.push('company name')
        if (!profile.company_org_number) missingFields.push('company registration number')
        if (!profile.company_vat_number) missingFields.push('company VAT number')
        if (!profile.company_address) missingFields.push('company address')
      }
    }

    if (!bank) {
      missingFields.push('bank account')
    } else {
      if (!bank.account_country) missingFields.push('bank country')
      if (!bank.account_holder_type) missingFields.push('bank account type')
      if (!bank.account_number_iban) missingFields.push('IBAN / account number')
      if (!bank.routing_code) missingFields.push('routing / clearance code')
      if (bank.account_holder_type === 'company') {
        if (!bank.company_bank_type) missingFields.push('company bank type')
      } else if (!bank.bank_name) {
        missingFields.push('bank name')
      }
    }

    const newOrders = Number(orderCountRows[0]?.total || 0)
    const newPayouts = Number(payoutCountRows[0]?.total || 0)
    const newMessages = Number(productNoticeRows[0]?.total || 0)
    const profileIncomplete = missingFields.length > 0

    const latestMessageAt = [productNoticeRows[0]?.latest_at]
      .filter(Boolean)
      .sort()
      .pop() || null

    const profileStatus = profileStatusRows[0] || null
    const normalizedStatus = getSellerProfileStatus(profileStatus)
    const statusReason = getSellerProfileStatusReason(profileStatus)
    const isProfileBlocked = normalizedStatus === 'blocked'
    const isProfileRejected = normalizedStatus === 'rejected'
    const isProfileAccepted = normalizedStatus === 'verified'
    const rejectionReason = isProfileRejected ? statusReason : ''
    const profileStatusUpdatedAt = profileStatus?.status_updated_at || null

    let acceptedCount = 0
    if (isProfileAccepted && profileStatusUpdatedAt) {
      if (!sinceSql) {
        acceptedCount = 1
      } else {
        const statusUpdatedAtMs = new Date(profileStatusUpdatedAt).getTime()
        const sinceMs = new Date(sinceSql).getTime()
        if (!Number.isNaN(statusUpdatedAtMs) && !Number.isNaN(sinceMs) && statusUpdatedAtMs > sinceMs) {
          acceptedCount = 1
        }
      }
    }

    const items = [
      {
        id: 'seller-new-orders',
        title: 'New orders',
        description: newOrders > 0
          ? `${newOrders} new order${newOrders === 1 ? '' : 's'} arrived.`
          : 'No new orders since your last check.',
        count: newOrders,
        href: '/order-list',
        tone: 'success',
        created_at: orderCountRows[0]?.latest_at || null,
      },
      {
        id: 'seller-new-payouts',
        title: 'Payout updates',
        description: newPayouts > 0
          ? `${newPayouts} payout${newPayouts === 1 ? '' : 's'} marked as paid.`
          : 'No new payout updates since your last check.',
        count: newPayouts,
        href: '/payment-list',
        tone: 'info',
        created_at: payoutCountRows[0]?.latest_at || null,
      },
      {
        id: 'seller-new-messages',
        title: 'New messages',
        description: newMessages > 0
          ? `${newMessages} admin update${newMessages === 1 ? '' : 's'} need your attention.`
          : 'No new admin messages since your last check.',
        count: newMessages,
        href: '/product-list',
        tone: 'warning',
        created_at: latestMessageAt,
      },
      {
        id: 'seller-profile-blocked',
        title: 'Account suspended',
        description: isProfileBlocked
          ? (statusReason || 'Your seller account is currently suspended by admin.')
          : 'Your seller account is active.',
        count: isProfileBlocked ? 1 : 0,
        href: '/profile-registration',
        tone: 'error',
        created_at: profileStatusUpdatedAt,
        persistent: true,
      },
      {
        id: 'seller-profile-rejected',
        title: 'Profile rejected',
        description: isProfileRejected
          ? rejectionReason
          : 'Your profile is not currently rejected.',
        count: isProfileRejected ? 1 : 0,
        href: '/profile-registration',
        tone: 'error',
        created_at: profileStatusUpdatedAt,
        persistent: true,
      },
      {
        id: 'seller-profile-accepted',
        title: 'Profile accepted',
        description: acceptedCount > 0
          ? 'Your seller profile has been approved by admin.'
          : 'No new profile approval updates.',
        count: acceptedCount,
        href: '/',
        tone: 'success',
        created_at: profileStatusUpdatedAt,
      },
      {
        id: 'seller-profile-missing',
        title: 'Profile data missing',
        description: profileIncomplete
          ? `Complete ${missingFields.slice(0, 3).join(', ')}${missingFields.length > 3 ? ' and more' : ''}.`
          : 'Your profile and payout details are complete.',
        count: profileIncomplete ? 1 : 0,
        href: '/profile-registration',
        tone: profileIncomplete ? 'error' : 'neutral',
        created_at: null,
        persistent: true,
      },
    ]

    const sellerStatusItems = items.filter((item) =>
      item.id === 'seller-profile-blocked'
      || item.id === 'seller-profile-rejected'
      || item.id === 'seller-profile-accepted',
    )

    return res.status(200).json({
      role: auth.role,
      unread_count: sellerStatusItems.reduce((sum, item) => sum + item.count, 0),
      items: sellerStatusItems,
    })
  } catch (error) {
    console.error('Failed loading notification summary:', error)
    return res.status(500).json({ message: 'Database error' })
  }
})


// ===== Store Payment Method =====
app.post('/api/payment-options', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const {
    provider = 'stripe',
    paymentMethodId,
    customerId,
    name,
    isDefault = true,
  } = req.body || {}

  if (!paymentMethodId || !name) {
    return res.status(400).json({ message: 'Missing payment method reference' })
  }
  try {
    let stripeCustomerId = customerId
    const stripePaymentMethodId = paymentMethodId
    let storedBrand: string | null
    let storedLast4: string | null
    let storedExpMonth: number | null
    let storedExpYear: number | null

    if (!stripeCustomerId) {
      const [existingCustomer] = await db.query<RowDataPacket[]>(
        'SELECT customer_id FROM payment_methods WHERE user_id = ? AND customer_id IS NOT NULL ORDER BY is_default DESC, id DESC LIMIT 1',
        [auth.id],
      )
      stripeCustomerId = existingCustomer[0]?.customer_id || null
    }

    if (!stripeCustomerId) {
      const [users] = await db.query<RowDataPacket[]>(
        'SELECT email FROM users WHERE id = ?', [auth.id]
      )
      const user = users[0] || {}
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.email || undefined,
        metadata: { userId: String(auth.id) },
      })
      stripeCustomerId = customer.id
    }

    const paymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId)
    storedBrand = paymentMethod?.card?.brand || null
    storedLast4 = paymentMethod?.card?.last4 || null
    storedExpMonth = paymentMethod?.card?.exp_month || null
    storedExpYear = paymentMethod?.card?.exp_year || null

    await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: stripeCustomerId })

    if (isDefault && stripeCustomerId && stripePaymentMethodId) {
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { default_payment_method: stripePaymentMethodId },
      })
    }

    if (isDefault) {
      await db.query('UPDATE payment_methods SET is_default = FALSE WHERE user_id = ?', [auth.id])
    }

    const [result] = await db.query<ResultSetHeader>(
      'INSERT INTO payment_methods (user_id, provider, payment_method_id, customer_id, card_brand, card_last4, exp_month, exp_year, cardholder_name, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        auth.id,
        provider,
        stripePaymentMethodId || null,
        stripeCustomerId || null,
        storedBrand,
        storedLast4,
        storedExpMonth,
        storedExpYear,
        name,
        Boolean(isDefault),
      ],
    )

    res.status(201).json({
      id: result.insertId,
      paymentMethod: {
        brand: storedBrand,
        last4: storedLast4,
        expMonth: storedExpMonth,
        expYear: storedExpYear,
        name,
      },
    })
  } catch (err) {
    console.error('Payment method store error:', err)
    res.status(500).json({ message: 'Failed to save payment method' })
  }
})

// ===== Swish Payment Request =====
app.post('/api/swish/payment-request', async (req: Request, res: Response) => {
  try {
    if (!swishApi) {
      return res.status(503).json({
        success: false,
        message: 'Swish service is not configured on this server.',
      })
    }

    const {
      amount,
      payeeAlias,
      payerAlias,
      message,
      payeePaymentReference,
      callbackUrl,
    } = req.body || {}

    // Validate required fields
    if (!amount || !payeeAlias || !message || !payeePaymentReference || !callbackUrl) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: amount, payeeAlias, message, payeePaymentReference, callbackUrl',
      })
    }

    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Must be a positive number.',
      })
    }

    const normalizedPayeeAlias = String(payeeAlias || '').trim()
    if (!/^\d{10}$/.test(normalizedPayeeAlias)) {
      return res.status(400).json({
        success: false,
        message: 'payeeAlias must be a 10-digit Swish number.',
      })
    }

    const normalizedPayeePaymentReference = String(payeePaymentReference || '').trim()
    if (!/^[A-Za-z0-9\-]{1,35}$/.test(normalizedPayeePaymentReference)) {
      return res.status(400).json({
        success: false,
        message: 'payeePaymentReference must be 1-35 chars (A-Z, a-z, 0-9, -).',
      })
    }

    const normalizedMessage = String(message || '').trim()
    if (!normalizedMessage || normalizedMessage.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'message is required and must be at most 50 characters.',
      })
    }

    const normalizedPayerAliasRaw = String(payerAlias || '').trim()
    const normalizedPayerAlias = normalizedPayerAliasRaw.replace(/\s+/g, '')
    if (normalizedPayerAlias && !/^\d{8,15}$/.test(normalizedPayerAlias)) {
      return res.status(400).json({
        success: false,
        message: 'payerAlias must be digits only (8-15 chars) without + when provided.',
      })
    }

    const normalizedCallbackUrl = String(callbackUrl || '').trim()
    if (!/^https:\/\//i.test(normalizedCallbackUrl)) {
      return res.status(400).json({
        success: false,
        message: 'callbackUrl must use HTTPS (https://...)',
      })
    }

    console.log('[API] Swish payment request:', {
      amount,
      payeeAlias: normalizedPayeeAlias,
      message: normalizedMessage,
      reference: normalizedPayeePaymentReference,
    })

    const callbackIdentifier = crypto.randomBytes(16).toString('hex').toUpperCase()

    // Create payment request via Swish API
    const paymentRequest = await swishApi.createPaymentRequest({
      payeePaymentReference: normalizedPayeePaymentReference,
      callbackUrl: normalizedCallbackUrl,
      payeeAlias: normalizedPayeeAlias,
      currency: 'SEK',
      payerAlias: normalizedPayerAlias || undefined,
      amount: String(amount),
      message: normalizedMessage,
      callbackIdentifier,
    })

    res.status(201).json({
      success: true,
      message: 'Payment request created successfully',
      data: {
        instructionUUID: paymentRequest.instructionUUID,
        id: paymentRequest.id,
        location: paymentRequest.location,
        paymentRequestToken: paymentRequest.paymentRequestToken,
      },
    })
  } catch (error: any) {
    console.error('[API] Swish payment request error:', error)

    const statusCode =
      typeof error.code === 'number' && error.code >= 400 && error.code <= 599
        ? error.code
        : 500
    const message = error.message || 'Failed to create Swish payment request'

    res.status(statusCode).json({
      success: false,
      message,
      error: error.code || 'UNKNOWN_ERROR',
      details: error.details,
    })
  }
})

// ===== Swish Payment Status =====
app.post('/api/swish/payment-status', async (req: Request, res: Response) => {
  try {
    if (!swishApi) {
      return res.status(503).json({
        success: false,
        message: 'Swish service is not configured on this server.',
      })
    }

    const { instructionUUID } = req.body || {}

    if (!instructionUUID) {
      return res.status(400).json({
        success: false,
        message: 'instructionUUID is required',
      })
    }

    console.log('[API] Checking Swish payment status:', { instructionUUID })

    // Get payment status from Swish API
    const paymentStatus = await swishApi.getPaymentStatus(instructionUUID)

    res.status(200).json({
      success: true,
      message: 'Payment status retrieved successfully',
      data: paymentStatus,
    })
  } catch (error: any) {
    console.error('[API] Swish payment status error:', error)

    const statusCode = error.code === 400 ? 400 : 500
    const message = error.message || 'Failed to retrieve Swish payment status'

    res.status(statusCode).json({
      success: false,
      message,
      error: error.code || 'UNKNOWN_ERROR',
      details: error.details,
    })
  }
})

// ===== Swish Payment Callback (for webhook) =====
app.post('/api/swish/callback', async (req: Request, res: Response) => {
  try {
    const { instructionUUID, status, amount, timestamp } = req.body || {}

    console.log('[Webhook] Swish callback received:', {
      instructionUUID,
      status,
      amount,
      timestamp,
    })

    // In a real application, you would:
    // 1. Verify the callback signature
    // 2. Update the order status in database
    // 3. Trigger order confirmation emails
    // 4. Handle webhook security (rate limiting, signature verification, etc.)

    // For now, just acknowledge receipt
    res.status(200).json({
      success: true,
      message: 'Callback received',
    })
  } catch (error) {
    console.error('[Webhook] Swish callback error:', error)
    res.status(500).json({
      success: false,
      message: 'Failed to process callback',
    })
  }
})

// ===== Dev Utility: Promote Current User to Admin =====
app.post('/api/dev/promote-me-admin', async (req: Request, res: Response) => {
  if (config.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' })
  }

  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const [result] = await db.query<ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [
      'admin',
      auth.id,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' })
    }

    res.status(200).json({ message: 'Current user promoted to admin', user_id: auth.id, role: 'admin' })
  } catch (error) {
    console.error('Failed to promote user to admin:', error)
    res.status(500).json({ message: 'Database error' })
  }
})


// ===== Profile Registration Route =====

const ensureProfilePictureUrlColumn = async () => {
  if (hasProfilePictureUrlColumnCache === true) return
  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM profiles LIKE 'profile_picture_url'")
    if (rows.length === 0) {
      await db.query('ALTER TABLE profiles ADD COLUMN profile_picture_url VARCHAR(2000) NULL')
    }
    hasProfilePictureUrlColumnCache = true
  } catch (error) {
    hasProfilePictureUrlColumnCache = null
    console.error('Failed ensuring profiles.profile_picture_url column:', error)
  }
}

const ensureProfileDisplayNameColumn = async () => {
  if (hasProfileDisplayNameColumnCache === true) return
  try {
    const [rows] = await db.query<RowDataPacket[]>("SHOW COLUMNS FROM profiles LIKE 'display_name'")
    if (rows.length === 0) {
      await db.query('ALTER TABLE profiles ADD COLUMN display_name VARCHAR(255) NULL')
    }
    hasProfileDisplayNameColumnCache = true
  } catch (error) {
    hasProfileDisplayNameColumnCache = null
    console.error('Failed ensuring profiles.display_name column:', error)
  }
}

const ensureBankAccountsTable = async () => {
  if (hasBankAccountsTableCache === true) return
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        account_country VARCHAR(100) NOT NULL,
        account_holder_type ENUM('private', 'company') NOT NULL,
        routing_code VARCHAR(100) NULL,
        account_number_iban VARCHAR(100) NOT NULL,
        company_bank_type ENUM('bankgiro', 'plusgiro') NULL,
        bank_name VARCHAR(150) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_bank_accounts_user (user_id),
        INDEX idx_bank_accounts_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
    hasBankAccountsTableCache = true
  } catch (error) {
    hasBankAccountsTableCache = null
    console.error('Failed ensuring bank_accounts table:', error)
    throw error
  }
}

const isSwedenCountry = (value?: string | null) => {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'sweden' || normalized === 'se'
}

const countDigits = (value?: string | null) => String(value || '').replace(/\D/g, '').length

// Multer config for company logo + profile picture upload
const profileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const subdir = file.fieldname === 'profilePicture' ? 'profile_pictures' : 'company_logos'
      const dir = path.join(__dirname, 'uploads', subdir)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
      cb(null, uniqueSuffix + path.extname(file.originalname))
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/
    const extname = allowed.test(path.extname(file.originalname).toLowerCase())
    const mimetype = allowed.test(file.mimetype)
    if (extname && mimetype) return cb(null, true)
    cb(new Error('Only image files are allowed'))
  },
})

app.post('/api/profiles', profileUpload.fields([{ name: 'companyLogo', maxCount: 1 }, { name: 'profilePicture', maxCount: 1 }]), async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  await ensureProfilesStatusColumns()
  await ensureProfilePictureUrlColumn()
  await ensureProfileDisplayNameColumn()

  const body = req.body
  const uploadedFiles = req.files as Record<string, Express.Multer.File[]> | undefined
  const logoFile = uploadedFiles?.['companyLogo']?.[0]
  const profilePictureFile = uploadedFiles?.['profilePicture']?.[0]
  const companyLogoUrl = logoFile
    ? `/uploads/company_logos/${logoFile.filename}`
    : (body.company_logo_url || null)
  const profilePictureUrl = profilePictureFile
    ? `/uploads/profile_pictures/${profilePictureFile.filename}`
    : (body.profile_picture_url || null)

  const profileData = {
    first_name: body.first_name,
    last_name: body.last_name,
    street: body.street,
    city: body.city,
    state: body.state || null,
    country: body.country,
    zip: body.zip,
    phone_extension: body.phone_extension,
    phone: body.phone,
    display_name: body.display_name || null,
    profile_type: body.profile_type,
    personal_id_number: body.personal_id_number || null,
    clearance_number: body.clearance_number || null,
    personal_account_number: body.personal_account_number || null,
    personal_bank_name: body.personal_bank_name || null,
    company_name: body.company_name || null,
    company_org_number: body.company_org_number || null,
    company_vat_number: body.company_vat_number || null,
    company_address: body.company_address || null,
    company_bank_type: body.company_bank_type || null,
    company_account_number: body.company_account_number || null,
    company_logo_url: companyLogoUrl,
    profile_picture_url: profilePictureUrl,
  }

  if (!profileData.first_name || !profileData.last_name || !profileData.street || !profileData.city || !profileData.country || !profileData.zip || !profileData.phone) {
    return res.status(400).json({ message: 'Required fields are missing' })
  }

  if (String(profileData.first_name || '').trim().length > 30) {
    return res.status(400).json({ message: 'First name cannot exceed 30 characters.' })
  }

  if (String(profileData.last_name || '').trim().length > 30) {
    return res.status(400).json({ message: 'Last name cannot exceed 30 characters.' })
  }

  if (String(profileData.display_name || '').trim().length > 30) {
    return res.status(400).json({ message: 'Display name cannot exceed 30 characters.' })
  }

  if (String(profileData.city || '').trim().length > 30) {
    return res.status(400).json({ message: 'City cannot exceed 30 characters.' })
  }

  if (String(profileData.state || '').trim().length > 30) {
    return res.status(400).json({ message: 'State cannot exceed 30 characters.' })
  }

  if (countDigits(String(profileData.phone || '')) > 15) {
    return res.status(400).json({ message: 'Phone number cannot exceed 15 digits.' })
  }

  if (countDigits(String(profileData.zip || '')) > 10) {
    return res.status(400).json({ message: 'Postal code cannot exceed 10 digits.' })
  }

  if (String(profileData.street || '').trim().length > 80) {
    return res.status(400).json({ message: 'Street address cannot exceed 80 characters.' })
  }

  if (countDigits(String(profileData.personal_id_number || '')) > 30) {
    return res.status(400).json({ message: 'Personal identification number cannot exceed 30 digits.' })
  }

  if (String(profileData.company_name || '').trim().length > 50) {
    return res.status(400).json({ message: 'Company name cannot exceed 50 characters.' })
  }

  if (countDigits(String(profileData.company_org_number || '')) > 30) {
    return res.status(400).json({ message: 'Organization number cannot exceed 30 digits.' })
  }

  if (countDigits(String(profileData.company_vat_number || '')) > 30) {
    return res.status(400).json({ message: 'VAT number cannot exceed 30 digits.' })
  }

  if (String(profileData.company_address || '').trim().length > 100) {
    return res.status(400).json({ message: 'Company address cannot exceed 100 characters.' })
  }

  try {
    const [existing] = await db.query<RowDataPacket[]>(
      'SELECT id, status, status_reason, is_verified, rejection_reason FROM profiles WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [auth.id],
    )

    if (existing.length) {
      const existingProfile = existing[0]
      const existingStatus = getSellerProfileStatus(existingProfile)
      const isResubmittingRejectedProfile = existingStatus === 'rejected'
      const nextStatus: SellerProfileStatus = isResubmittingRejectedProfile ? 'pending' : existingStatus
      const retainedStatusReason = String(existingProfile.status_reason || '').trim() || null
      const nextStatusReason = nextStatus === 'verified'
        ? null
        : (isResubmittingRejectedProfile ? null : retainedStatusReason)
      const nextStatusCompat = buildSellerProfileCompatFields({ status: nextStatus, status_reason: nextStatusReason })

      await db.query(
        `UPDATE profiles SET first_name=?, last_name=?, street=?, city=?, state=?, country=?, zip=?, phone_extension=?, phone=?, display_name=?, profile_type=?, personal_id_number=?, clearance_number=?, personal_account_number=?, personal_bank_name=?, company_name=?, company_org_number=?, company_vat_number=?, company_address=?, company_bank_type=?, company_account_number=?, company_logo_url=?, profile_picture_url=?, status=?, status_reason=?, is_verified=?, is_blocked=?, rejection_reason=?, blocked_reason=? WHERE id=?`,
        [
          profileData.first_name,
          profileData.last_name,
          profileData.street,
          profileData.city,
          profileData.state,
          profileData.country,
          profileData.zip,
          profileData.phone_extension,
          profileData.phone,
          profileData.display_name,
          profileData.profile_type,
          profileData.personal_id_number,
          profileData.clearance_number,
          profileData.personal_account_number,
          profileData.personal_bank_name,
          profileData.company_name,
          profileData.company_org_number,
          profileData.company_vat_number,
          profileData.company_address,
          profileData.company_bank_type,
          profileData.company_account_number,
          profileData.company_logo_url,
          profileData.profile_picture_url,
          nextStatus,
          nextStatusReason,
          nextStatusCompat.is_verified,
          nextStatusCompat.is_blocked,
          nextStatusCompat.rejection_reason,
          nextStatusCompat.blocked_reason,
          existingProfile.id,
        ],
      )

      emitToAdmin('profile:updated', {
        profile_id: existingProfile.id,
        seller_id: auth.id,
        action: isResubmittingRejectedProfile ? 'resubmitted' : 'updated',
        status: isResubmittingRejectedProfile ? 'pending' : undefined,
      })
      return res.status(200).json({
        id: existingProfile.id,
        ...profileData,
        ...nextStatusCompat,
      })
    }

    const [result] = await db.query<ResultSetHeader>('INSERT INTO profiles SET ?', [
      {
        user_id: auth.id,
        first_name: profileData.first_name,
        last_name: profileData.last_name,
        street: profileData.street,
        city: profileData.city,
        state: profileData.state,
        country: profileData.country,
        zip: profileData.zip,
        phone_extension: profileData.phone_extension,
        phone: profileData.phone,
        display_name: profileData.display_name,
        profile_type: profileData.profile_type,
        personal_id_number: profileData.personal_id_number,
        clearance_number: profileData.clearance_number,
        personal_account_number: profileData.personal_account_number,
        personal_bank_name: profileData.personal_bank_name,
        company_name: profileData.company_name,
        company_org_number: profileData.company_org_number,
        company_vat_number: profileData.company_vat_number,
        company_address: profileData.company_address,
        company_bank_type: profileData.company_bank_type,
        company_account_number: profileData.company_account_number,
        company_logo_url: profileData.company_logo_url,
        profile_picture_url: profileData.profile_picture_url,
        status: 'pending',
        status_reason: null,
        is_verified: 0,
        is_blocked: 0,
        rejection_reason: null,
        blocked_reason: null,
      },
    ])
    emitToAdmin('profile:updated', {
      profile_id: result.insertId,
      seller_id: auth.id,
      action: 'created',
    })
    res.status(201).json({ id: result.insertId, ...profileData, ...buildSellerProfileCompatFields({ status: 'pending', status_reason: null }) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Update Profile Picture Only =====
app.put('/api/profiles/picture', profileUpload.fields([{ name: 'profilePicture', maxCount: 1 }]), async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  await ensureProfilePictureUrlColumn()

  const uploadedFiles = req.files as Record<string, Express.Multer.File[]> | undefined
  const profilePictureFile = uploadedFiles?.['profilePicture']?.[0]

  if (!profilePictureFile) {
    return res.status(400).json({ message: 'No profile picture provided' })
  }

  const profilePictureUrl = `/uploads/profile_pictures/${profilePictureFile.filename}`

  try {
    const [existing] = await db.query<RowDataPacket[]>(
      'SELECT id FROM profiles WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [auth.id],
    )

    if (existing.length) {
      await db.query(
        'UPDATE profiles SET profile_picture_url = ? WHERE id = ?',
        [profilePictureUrl, existing[0].id],
      )
    } else {
      await db.query(
        'INSERT INTO profiles (user_id, profile_picture_url) VALUES (?, ?)',
        [auth.id, profilePictureUrl],
      )
    }

    res.status(200).json({ profile_picture_url: profilePictureUrl })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Profile Lookup Route =====
app.get('/api/profiles', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureProfilesStatusColumns()
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [auth.id],
    )
    if (!rows.length) {
      return res.json(null)
    }
    res.json({
      ...rows[0],
      ...buildSellerProfileCompatFields(rows[0]),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

app.get('/api/bank-account', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureBankAccountsTable()

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
        account_country,
        account_holder_type,
        routing_code,
        account_number_iban,
        company_bank_type,
        bank_name
      FROM bank_accounts
      WHERE user_id = ?
      LIMIT 1`,
      [auth.id],
    )

    if (!rows.length) {
      return res.json(null)
    }

    res.json(rows[0])
  } catch (error) {
    console.error('Failed loading bank account:', error)
    res.status(500).json({ message: 'Database error' })
  }
})

app.put('/api/bank-account', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureBankAccountsTable()

    const accountCountry = String(req.body?.account_country || '').trim()
    const accountHolderType = String(req.body?.account_holder_type || '').trim().toLowerCase()
    const routingCode = String(req.body?.routing_code || '').trim()
    const accountNumberOrIban = String(req.body?.account_number_iban || '').trim()
    const companyBankTypeRaw = String(req.body?.company_bank_type || '').trim().toLowerCase()
    const bankName = String(req.body?.bank_name || '').trim()
    const companyBankType = companyBankTypeRaw === 'bankgiro' || companyBankTypeRaw === 'plusgiro'
      ? companyBankTypeRaw
      : null

    if (!accountCountry) {
      return res.status(400).json({ message: 'Account country is required.' })
    }

    if (accountHolderType !== 'private' && accountHolderType !== 'company') {
      return res.status(400).json({ message: 'Account type must be private or company.' })
    }

    if (routingCode.length > 30) {
      return res.status(400).json({ message: 'SWIFT / Clearance code cannot exceed 30 characters.' })
    }

    if (accountNumberOrIban.length > 30) {
      return res.status(400).json({ message: 'IBAN / Account number cannot exceed 30 characters.' })
    }

    const isSweden = isSwedenCountry(accountCountry)

    if (accountHolderType === 'private' && isSweden) {
      if (!bankName || !routingCode || !accountNumberOrIban) {
        return res.status(400).json({ message: 'Bank name, clearance number, and account number are required.' })
      }
    }

    if (accountHolderType === 'private' && !isSweden) {
      if (!routingCode || !accountNumberOrIban) {
        return res.status(400).json({ message: 'SWIFT / BIC and IBAN are required.' })
      }
    }

    if (accountHolderType === 'company' && isSweden) {
      if (!companyBankType || !accountNumberOrIban) {
        return res.status(400).json({ message: 'Bankgiro/Plusgiro and account number are required.' })
      }
    }

    if (accountHolderType === 'company' && !isSweden) {
      if (!routingCode || !accountNumberOrIban) {
        return res.status(400).json({ message: 'SWIFT / BIC and IBAN are required.' })
      }
    }

    const payload = {
      user_id: auth.id,
      account_country: accountCountry,
      account_holder_type: accountHolderType,
      routing_code: routingCode || null,
      account_number_iban: accountNumberOrIban,
      company_bank_type: companyBankType,
      bank_name: bankName || null,
    }

    await db.query(
      `INSERT INTO bank_accounts (user_id, account_country, account_holder_type, routing_code, account_number_iban, company_bank_type, bank_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         account_country = VALUES(account_country),
         account_holder_type = VALUES(account_holder_type),
         routing_code = VALUES(routing_code),
         account_number_iban = VALUES(account_number_iban),
         company_bank_type = VALUES(company_bank_type),
         bank_name = VALUES(bank_name)`,
      [
        payload.user_id,
        payload.account_country,
        payload.account_holder_type,
        payload.routing_code,
        payload.account_number_iban,
        payload.company_bank_type,
        payload.bank_name,
      ],
    )

    res.status(200).json(payload)
  } catch (error) {
    console.error('Failed updating bank account:', error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Portal Data =====
app.get('/api/admin/portal', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    const [paymentDateColumnExists, payoutReferenceColumnExists] = await Promise.all([
      hasSalesPayoutPaymentDateColumn(),
      hasSalesPayoutReferenceColumn(),
    ])

    const paymentDateSelect = paymentDateColumnExists ? 's.payout_payment_date' : 'NULL AS payout_payment_date'
    const payoutReferenceSelect = payoutReferenceColumnExists ? 's.payout_reference' : 'NULL AS payout_reference'

    await ensureProfilesStatusColumns()

    const [profiles] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.user_id,
        u.email,
        p.first_name,
        p.last_name,
        p.phone,
        p.country,
        p.city,
        p.street,
        p.profile_type,
        p.company_name,
        p.company_org_number,
        p.company_vat_number,
        p.status,
        p.status_reason,
        p.created_at
      FROM profiles p
      INNER JOIN users u ON u.id = p.user_id
      WHERE COALESCE(p.status, 'pending') = 'pending'
      ORDER BY p.created_at DESC`,
    )

    const [products] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.seller_id,
        u.email AS seller_email,
        p.name,
        p.category,
        p.approval_status,
        p.status,
        p.created_at
      FROM products p
      INNER JOIN users u ON u.id = p.seller_id
      WHERE p.approval_status = 'pending'
      ORDER BY p.created_at DESC`,
    )

    const [orders] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id,
        s.order_id,
        s.order_date,
        s.order_status,
        s.payout_status,
        ${paymentDateSelect},
        ${payoutReferenceSelect},
        s.grand_total,
        COALESCE(st.total_tax, s.tax_amount, 0) AS tax_amount,
        s.commission_amount,
        s.seller_id,
        u.email AS seller_email,
        c.name AS customer_name
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) AS total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      LEFT JOIN users u ON u.id = s.seller_id
      LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.order_date DESC
      LIMIT 300`,
    )

    const [totalsRows] = await db.query<RowDataPacket[]>(
      `SELECT
        COALESCE(SUM(s.grand_total), 0) AS total_sales,
        COALESCE(SUM(s.commission_amount), 0) AS total_commission,
        COALESCE(SUM(COALESCE(st.total_tax, s.tax_amount, 0)), 0) AS total_tax
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) AS total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id`,
    )

    const [bankDetails] = await db.query<RowDataPacket[]>(
      `SELECT
        p.user_id,
        u.email,
        p.profile_type,
        p.personal_bank_name,
        p.personal_account_number,
        p.company_name,
        p.company_bank_type,
        p.company_account_number
      FROM profiles p
      INNER JOIN users u ON u.id = p.user_id
      INNER JOIN (
        SELECT user_id, MAX(created_at) AS max_created_at
        FROM profiles
        GROUP BY user_id
      ) latest ON latest.user_id = p.user_id AND latest.max_created_at = p.created_at
      ORDER BY p.user_id ASC`,
    )

    const [pendingPayouts] = await db.query<RowDataPacket[]>(
      `SELECT
        s.seller_id,
        u.email AS seller_email,
        YEAR(s.order_date) AS year_num,
        MONTH(s.order_date) AS month_num,
        COUNT(*) AS order_count,
        COALESCE(SUM(s.grand_total), 0) AS total_sales,
        COALESCE(SUM(s.commission_amount), 0) AS total_commission,
        COALESCE(SUM(COALESCE(st.total_tax, s.tax_amount, 0)), 0) AS total_tax
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) AS total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      INNER JOIN users u ON u.id = s.seller_id
      WHERE s.payout_status = 'unpaid'
      GROUP BY s.seller_id, u.email, YEAR(s.order_date), MONTH(s.order_date)
      ORDER BY year_num DESC, month_num DESC, s.seller_id ASC`,
    )

    const totalsRow = totalsRows[0] || {
      total_sales: 0,
      total_commission: 0,
      total_tax: 0,
    }

    const totalSales = Number(totalsRow.total_sales || 0)
    const totalCommission = Number(totalsRow.total_commission || 0)
    const totalTax = Number(totalsRow.total_tax || 0)

    res.status(200).json({
      profiles,
      products,
      orders: orders.map((order) => ({
        ...order,
        grand_total: Number(order.grand_total || 0),
        tax_amount: Number(order.tax_amount || 0),
        commission_amount: Number(order.commission_amount || 0),
      })),
      totals: {
        total_sales: roundToTwo(totalSales),
        total_commission: roundToTwo(totalCommission),
        total_tax: roundToTwo(totalTax),
        total_expenses: roundToTwo(totalCommission + totalTax),
      },
      bank_details: bankDetails,
      pending_monthly_payouts: pendingPayouts.map((row) => {
        const sales = Number(row.total_sales || 0)
        const tax = Number(row.total_tax || 0)
        const commission = Number(row.total_commission || 0)

        return {
          seller_id: row.seller_id,
          seller_email: row.seller_email,
          year: row.year_num,
          month: row.month_num,
          order_count: Number(row.order_count || 0),
          total_sales: roundToTwo(sales),
          total_tax: roundToTwo(tax),
          total_commission: roundToTwo(commission),
          net_payable: calculateNetEarning(sales, tax, commission),
        }
      }),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

app.get('/api/admin/sellers/:sellerId/profile', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const sellerId = Number(req.params.sellerId)
  if (!Number.isFinite(sellerId) || sellerId <= 0) {
    return res.status(400).json({ message: 'Invalid seller id' })
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
        u.id AS seller_id,
        u.email,
        p.first_name,
        p.last_name,
        p.phone,
        p.country,
        p.city,
        p.street,
        p.profile_type,
        p.company_name,
        p.company_org_number,
        p.company_vat_number,
        p.is_verified,
        p.created_at
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ?
      ORDER BY p.created_at DESC
      LIMIT 1`,
      [sellerId],
    )

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Seller not found' })
    }

    res.status(200).json(rows[0])
  } catch (err) {
    console.error('Error loading seller profile:', err)
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({ message: 'Failed to load seller profile', details: errorMessage })
  }
})

app.get('/api/admin/sellers', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    await ensureProfilesStatusColumns()
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
        u.id AS seller_id,
        u.email,
        u.created_at AS seller_created_at,
        p.id AS profile_id,
        p.first_name,
        p.last_name,
        p.phone,
        p.profile_type,
        p.country,
        p.city,
        p.state,
        p.zip,
        p.street,
        p.company_name,
        p.company_org_number,
        p.company_vat_number,
        p.status,
        p.status_reason,
        p.is_verified,
        p.display_name,
        p.rejection_reason,
        p.is_blocked,
        p.blocked_reason,
        p.last_login,
        p.created_at AS profile_created_at
      FROM users u
      LEFT JOIN profiles p
        ON p.id = (
          SELECT p2.id
          FROM profiles p2
          WHERE p2.user_id = u.id
          ORDER BY p2.created_at DESC, p2.id DESC
          LIMIT 1
        )
      WHERE u.role = 'seller'
      ORDER BY u.created_at DESC`,
    )

    res.status(200).json(rows.map((row) => ({
      ...row,
      ...buildSellerProfileCompatFields(row),
    })))
  } catch (err) {
    console.error('Error loading sellers:', err)
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({ message: 'Failed to load sellers', details: errorMessage })
  }
})

// ===== Admin Get All Orders (with Items) =====
app.get('/api/admin/orders', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  try {
    await Promise.all([ensureSalesPayoutColumns(), ensureSalesPaymentIntentIdColumn()])
    const [paymentDateColumnExists, paymentIntentIdColumnExists] = await Promise.all([
      hasSalesPayoutPaymentDateColumn(),
      hasSalesPaymentIntentIdColumn(),
    ])
    const payoutPaymentDateSelect = paymentDateColumnExists
      ? 's.payout_payment_date'
      : 'NULL AS payout_payment_date'
    const paymentIntentIdSelect = paymentIntentIdColumnExists
      ? 's.payment_intent_id'
      : 'NULL AS payment_intent_id'

    const [allItems] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id as sale_id,
        s.order_id,
        ${paymentIntentIdSelect},
        s.customer_id,
        s.seller_id,
        s.order_date,
        s.order_status,
        s.payout_status as payment_status,
        s.order_status as shipping_status,
        COALESCE(st.total_tax, s.tax_amount, 0) as tax_amount,
        0 as shipping_fee,
        0 as discount_amount,
        s.grand_total,
        s.commission_amount,
        s.payout_status,
        ${payoutPaymentDateSelect},
        s.created_at,
        s.updated_at,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.shipping_street,
        c.shipping_city,
        c.shipping_state,
        c.shipping_zip,
        c.shipping_country,
        u.email as seller_email,
        sp.first_name as seller_first_name,
        sp.last_name as seller_last_name,
        sp.company_name as seller_company_name,
        sp.profile_type as seller_profile_type,
        ba.company_bank_type,
        ba.account_number_iban as company_account_number,
        ba.bank_name as personal_bank_name,
        ba.account_number_iban as personal_account_number,
        ba.routing_code as clearance_number,
        si.id as item_id,
        si.product_type,
        si.product_id,
        si.product_name,
        COALESCE(p.type, 'physical') as item_type,
        p.category as item_category,
        p.main_image_url as item_main_image_url,
        COALESCE(pv.length_cm, pv_fallback.length_cm) as item_length_cm,
        COALESCE(pv.width_cm, pv_fallback.width_cm) as item_width_cm,
        COALESCE(pv.height_cm, pv_fallback.height_cm) as item_height_cm,
        COALESCE(pv.weight_kg, pv_fallback.weight_kg) as item_weight_kg,
        si.quantity,
        si.unit_price,
        (si.unit_price * si.quantity) as total_price,
        si.tax_amount as item_tax_amount
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.seller_id = u.id
      LEFT JOIN profiles sp ON sp.id = (
        SELECT p2.id
        FROM profiles p2
        WHERE p2.user_id = s.seller_id
        ORDER BY p2.created_at DESC, p2.id DESC
        LIMIT 1
      )
      LEFT JOIN bank_accounts ba ON ba.user_id = s.seller_id
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN products p ON si.product_id = p.id
      LEFT JOIN product_variants pv ON pv.product_id = si.product_id
        AND si.product_type = 'item'
        AND si.product_name LIKE '%(%:%)%'
        AND TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(si.product_name, '(', -1), ':', 1)) = pv.variant_name
        AND TRIM(TRAILING ')' FROM SUBSTRING_INDEX(SUBSTRING_INDEX(si.product_name, ':', -1), ')', 1)) = pv.variant_value
      LEFT JOIN product_variants pv_fallback ON pv_fallback.id = (
        SELECT pv2.id
        FROM product_variants pv2
        WHERE pv2.product_id = si.product_id
        ORDER BY pv2.id ASC
        LIMIT 1
      )
      ORDER BY s.order_date DESC, si.id`,
    )

    const ordersMap = new Map<number, any>()

    for (const row of allItems) {
      if (!ordersMap.has(row.sale_id)) {
        ordersMap.set(row.sale_id, {
          id: row.sale_id,
          order_id: row.order_id,
          payment_intent_id: row.payment_intent_id || null,
          customer_id: row.customer_id,
          seller_id: row.seller_id,
          seller_email: row.seller_email,
          order_date: row.order_date,
          order_status: row.order_status,
          payment_status: row.payment_status,
          shipping_status: row.shipping_status,
          tax_amount: Number(row.tax_amount || 0),
          shipping_fee: Number(row.shipping_fee || 0),
          discount_amount: Number(row.discount_amount || 0),
          grand_total: Number(row.grand_total || 0),
          commission_amount: Number(row.commission_amount || 0),
          payout_status: row.payout_status,
          payout_payment_date: row.payout_payment_date || (row.payout_status === 'paid' ? row.updated_at : null),
          seller_net_amount: calculateNetEarning(row.grand_total, row.tax_amount, row.commission_amount),
          created_at: row.created_at,
          updated_at: row.updated_at,
          customer_name: row.customer_name,
          customer_email: row.customer_email,
          customer_phone: row.customer_phone,
          shipping_street: row.shipping_street,
          shipping_city: row.shipping_city,
          shipping_state: row.shipping_state,
          shipping_zip: row.shipping_zip,
          shipping_country: row.shipping_country,
          seller_first_name: row.seller_first_name,
          seller_last_name: row.seller_last_name,
          seller_company_name: row.seller_company_name,
          seller_profile_type: row.seller_profile_type,
          company_bank_type: row.company_bank_type,
          company_account_number: row.company_account_number,
          personal_bank_name: row.personal_bank_name,
          personal_account_number: row.personal_account_number,
          clearance_number: row.clearance_number,
          items: [],
        })
      }

      const order = ordersMap.get(row.sale_id)!
      if (row.item_id) {
        order.items.push({
          id: row.item_id,
          product_type: row.product_type,
          product_id: row.product_id,
          product_name: row.product_name,
          sku: null,
          type: row.item_type || 'physical',
          category: row.item_category || null,
          main_image_url: row.item_main_image_url || null,
          length_cm: row.item_length_cm != null ? Number(row.item_length_cm) : null,
          width_cm: row.item_width_cm != null ? Number(row.item_width_cm) : null,
          height_cm: row.item_height_cm != null ? Number(row.item_height_cm) : null,
          weight_kg: row.item_weight_kg != null ? Number(row.item_weight_kg) : null,
          quantity: Number(row.quantity || 0),
          unit_price: Number(row.unit_price || 0),
          total_price: Number(row.total_price || 0),
          tax_amount: Number(row.item_tax_amount || 0),
          commission_amount: 0,
          status: 'pending',
        })
      }
    }

    res.status(200).json(Array.from(ordersMap.values()))
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Bulk Delete Selected Orders =====
app.delete('/api/admin/orders', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const orderIdsRaw = Array.isArray(req.body?.order_ids) ? req.body.order_ids : []
  const orderIds = orderIdsRaw
    .map((value: unknown) => Number(value))
    .filter((value: number) => Number.isFinite(value) && value > 0)

  if (orderIds.length === 0) {
    return res.status(400).json({ message: 'order_ids is required and must contain valid order ids' })
  }

  try {
    const placeholders = orderIds.map(() => '?').join(', ')
    const [result] = await db.query<ResultSetHeader>(
      `DELETE FROM sales WHERE id IN (${placeholders})`,
      orderIds,
    )

    res.status(200).json({
      message: 'Selected orders deleted successfully',
      deleted_count: result.affectedRows,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Bulk Payout Selected Orders =====
app.post('/api/admin/orders/payout', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const orderIdsRaw = Array.isArray(req.body?.order_ids) ? req.body.order_ids : []
  const payoutDateRaw = String(req.body?.payout_date || '').trim()
  const reference = String(req.body?.reference || '').trim()

  const orderIds = orderIdsRaw
    .map((value: any) => Number(value))
    .filter((value: number) => Number.isFinite(value) && value > 0)

  if (orderIds.length === 0) {
    return res.status(400).json({ message: 'order_ids is required and must contain valid order ids' })
  }

  if (!reference) {
    return res.status(400).json({ message: 'reference is required' })
  }

  let payoutDate = toCETDateTime()
  if (payoutDateRaw) {
    const parsed = new Date(payoutDateRaw)
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ message: 'Invalid payout_date' })
    }
    payoutDate = toCETDateTime(parsed)
  }

  try {
    await ensureSalesPayoutColumns()
    const placeholders = orderIds.map(() => '?').join(', ')
    const [selectedRows] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id,
        s.seller_id,
        s.order_id,
        s.order_date,
        s.grand_total,
        s.commission_amount,
        u.email AS seller_email,
        p.first_name AS seller_first_name,
        p.last_name AS seller_last_name,
        p.company_name AS seller_company_name,
        p.profile_type AS seller_profile_type
      FROM sales s
      LEFT JOIN users u ON u.id = s.seller_id
      LEFT JOIN profiles p ON p.id = (
        SELECT p2.id
        FROM profiles p2
        WHERE p2.user_id = s.seller_id
        ORDER BY p2.created_at DESC, p2.id DESC
        LIMIT 1
      )
      WHERE s.id IN (${placeholders})`,
      orderIds,
    )

    type SellerPayoutRow = {
      id: number
      seller_id: number
      order_id: string
      order_date: string
      revenue: number
      commission: number
      payoutAmount: number
      seller_email: string
      seller_first_name: string
      seller_last_name: string
      seller_company_name: string
      seller_profile_type: string
    }

    const payoutRows: SellerPayoutRow[] = selectedRows.map((row) => {
      const revenue = Number(row.grand_total || 0)
      const commission = Number(row.commission_amount || 0)
      const payoutAmount = roundToTwo(revenue - commission)

      return {
        id: Number(row.id || 0),
        seller_id: Number(row.seller_id || 0),
        order_id: String(row.order_id || ''),
        order_date: String(row.order_date || ''),
        revenue,
        commission,
        payoutAmount,
        seller_email: String(row.seller_email || ''),
        seller_first_name: String(row.seller_first_name || ''),
        seller_last_name: String(row.seller_last_name || ''),
        seller_company_name: String(row.seller_company_name || ''),
        seller_profile_type: String(row.seller_profile_type || ''),
      }
    })

    const totalPayoutAmount = payoutRows.reduce((sum, row) => sum + Number(row.payoutAmount || 0), 0)

    const [paymentDateColumnExists, payoutReferenceColumnExists] = await Promise.all([
      hasSalesPayoutPaymentDateColumn(),
      hasSalesPayoutReferenceColumn(),
    ])

    const updates: string[] = ["payout_status = 'paid'"]
    const values: any[] = []

    if (paymentDateColumnExists) {
      updates.push('payout_payment_date = ?')
      values.push(payoutDate)
    }

    if (payoutReferenceColumnExists) {
      updates.push('payout_reference = ?')
      values.push(reference)
    }

    values.push(...orderIds)

    const [result] = await db.query<ResultSetHeader>(
      `UPDATE sales
       SET ${updates.join(', ')}
       WHERE id IN (${placeholders})`,
      values,
    )

    const sellerIds = Array.from(new Set(selectedRows.map((row) => Number(row.seller_id)).filter((value) => value > 0)))
    const sellerReceiptEmails: Array<{ seller_id: number; email: string }> = []

    for (const sellerId of sellerIds) {
      const sellerOrders = payoutRows.filter((row) => Number(row.seller_id) === sellerId)

      const sellerRevenue = sellerOrders.reduce((sum, row) => sum + Number(row.revenue || 0), 0)
      const sellerCommission = sellerOrders.reduce((sum, row) => sum + Number(row.commission || 0), 0)
      const sellerPayout = sellerOrders.reduce((sum, row) => sum + Number(row.payoutAmount || 0), 0)

      const sellerProfile = sellerOrders[0]
      const fullName = `${String(sellerProfile?.seller_first_name || '').trim()} ${String(sellerProfile?.seller_last_name || '').trim()}`.trim()
      const sellerName = String(
        sellerProfile?.seller_profile_type === 'company'
          ? (sellerProfile?.seller_company_name || sellerProfile?.seller_email || `Seller #${sellerId}`)
          : (fullName || sellerProfile?.seller_email || `Seller #${sellerId}`),
      )

      const sellerEmail = String(sellerProfile?.seller_email || '').trim()
      if (sellerEmail) {
        const payoutEmailHtml = createSellerPayoutReceiptEmailHtml({
          company: {
            company_logo_url: String(config.EMAIL.companyLogoUrl || '').trim(),
            company_name: String(config.EMAIL.companyName || 'Smart Embedded System').trim(),
            company_email: String(config.EMAIL.address || config.SMTP.user || '').trim(),
            company_address: String(config.EMAIL.companyAddress || '').trim(),
            organization_number: String(config.COMPANY_ORGANIZATION_NUMBER || '').trim(),
          },
          seller_name: sellerName,
          payout_reference: reference,
          payout_date: String(payoutDate || ''),
          total_orders: sellerOrders.length,
          total_revenue: sellerRevenue,
          total_commission: sellerCommission,
          total_payout: sellerPayout,
          orders: sellerOrders.map((row) => ({
            order_id: String(row.order_id || ''),
            order_date: new Date(row.order_date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            }),
            revenue: Number(row.revenue || 0),
            commission: Number(row.commission || 0),
            payout: Number(row.payoutAmount || 0),
          })),
        })

        try {
          await sendEmail(
            sellerEmail,
            `Payout receipt ${reference}`,
            payoutEmailHtml,
          )
          sellerReceiptEmails.push({ seller_id: sellerId, email: sellerEmail })
        } catch (emailError) {
          console.error('Failed to send payout receipt email:', {
            sellerId,
            sellerEmail,
            emailError,
          })
        }
      }

      emitToSeller(sellerId, 'payout:approved', {
        seller_id: sellerId,
        reference,
        payout_date: payoutDate,
        order_ids: sellerOrders.map((row) => row.order_id),
        payout_amount: roundToTwo(sellerPayout),
      })
    }

    emitToAdmin('payment:processed', {
      reference,
      payout_date: payoutDate,
      order_ids: selectedRows.map((row) => row.order_id),
      payout_amount: roundToTwo(totalPayoutAmount),
    })

    res.status(200).json({
      message: 'Selected orders marked as paid out',
      updated_count: result.affectedRows,
      reference,
      payout_date: payoutDate,
      payout_amount: roundToTwo(totalPayoutAmount),
      seller_receipt_emails_sent: sellerReceiptEmails.length,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})


app.post('/api/admin/orders/message-seller', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const sellerEmail = String(req.body?.seller_email || '').trim()
  const subject = String(req.body?.subject || '').trim()
  const body = String(req.body?.body || '').trim()
  const orderId = String(req.body?.order_id || '').trim()

  if (!sellerEmail) {
    return res.status(400).json({ message: 'seller_email is required' })
  }

  if (!subject) {
    return res.status(400).json({ message: 'subject is required' })
  }

  if (!body) {
    return res.status(400).json({ message: 'body is required' })
  }

  const subjectWithPrefix = orderId && !subject.toLowerCase().includes(orderId.toLowerCase())
    ? `[Order ${orderId}] ${subject}`
    : subject

  try {
    await sendEmail(sellerEmail, subjectWithPrefix, body)

    return res.status(200).json({
      message: 'Seller email sent successfully',
      to: sellerEmail,
    })
  } catch (error) {
    console.error('Failed to send admin seller message:', error)
    const message = error instanceof Error ? error.message : 'Failed to send seller email'
    return res.status(500).json({ message })
  }
})
const updateSellerProfileStatus = async (profileId: number, status: SellerProfileStatus, reason?: string | null) => {
  await ensureProfilesStatusColumns()

  const normalizedReason = String(reason || '').trim() || null
  const [profileRows] = await db.query<RowDataPacket[]>(
    `SELECT p.id, p.user_id, u.email,
            COALESCE(p.display_name, p.first_name, '') AS seller_name
     FROM profiles p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ? LIMIT 1`,
    [profileId],
  )

  if (profileRows.length === 0) {
    return null
  }

  const nextReason = status === 'verified' ? null : normalizedReason
  await db.query<ResultSetHeader>(
    `UPDATE profiles
     SET status = ?,
         status_reason = ?,
         is_verified = ?,
         is_blocked = ?,
         rejection_reason = ?,
         blocked_reason = ?
     WHERE id = ?`,
    [
      status,
      nextReason,
      status === 'verified' ? 1 : 0,
      status === 'blocked' ? 1 : 0,
      status === 'rejected' ? nextReason : null,
      status === 'blocked' ? nextReason : null,
      profileId,
    ],
  )

  return {
    profile: profileRows[0],
    status,
    reason: nextReason,
  }
}

const notifySellerProfileStatusChange = async (
  profileId: number,
  target: { profile: RowDataPacket; status: SellerProfileStatus; reason: string | null },
) => {
  const sellerId = Number(target.profile.user_id)
  const sellerName = String(target.profile.seller_name || 'Seller').trim() || 'Seller'
  const platformName = config.SMTP.fromName || 'SellingPlatform'

  emitToSeller(sellerId, 'profile:updated', {
    profile_id: profileId,
    seller_id: sellerId,
    status: target.status,
    status_reason: target.reason,
    rejection_reason: target.status === 'rejected' ? target.reason : null,
    blocked_reason: target.status === 'blocked' ? target.reason : null,
  })

  if (target.status === 'verified') {
    emitToSeller(sellerId, 'profile:verified', {
      profile_id: profileId,
      seller_id: sellerId,
      status: 'verified',
    })
  }

  if (!target.profile.email) {
    return
  }

  try {
    if (target.status === 'verified') {
      const dashboardUrl = `${config.CLIENT_URL}/dashboard`
      await sendEmail(
        target.profile.email,
        `Your seller account has been approved — ${platformName}`,
        `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
  <h2 style="color:#16a34a;margin:0 0 12px;">Welcome aboard, ${sellerName}!</h2>
  <p style="color:#374151;margin:0 0 12px;">Great news — your seller profile on <strong>${platformName}</strong> has been reviewed and <strong style="color:#16a34a;">approved</strong>.</p>
  <p style="color:#374151;margin:0 0 20px;">You can now list products and start selling on the platform.</p>
  <a href="${dashboardUrl}" style="display:inline-block;padding:10px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Go to Dashboard</a>
</div>`,
      )
      return
    }

    if (target.status === 'pending') {
      const profileUrl = `${config.CLIENT_URL}/profile-registration`
      await sendEmail(
        target.profile.email,
        `Seller profile set to pending review — ${platformName}`,
        `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
  <h2 style="color:#d97706;margin:0 0 12px;">Profile Review Pending</h2>
  <p style="color:#374151;margin:0 0 12px;">Hi ${sellerName},</p>
  <p style="color:#374151;margin:0 0 12px;">Your seller profile on <strong>${platformName}</strong> has been moved to <strong>pending review</strong>.</p>
  <div style="background:#fffbeb;border-left:4px solid #d97706;padding:12px 16px;border-radius:4px;margin:16px 0;">
    <strong style="color:#b45309;font-size:13px;">Message from admin:</strong>
    <p style="color:#92400e;margin:8px 0 0;font-size:14px;white-space:pre-wrap;">${target.reason || 'No reason provided.'}</p>
  </div>
  <p style="color:#374151;margin:0 0 20px;">While your status is pending, you cannot add products and your products are hidden from customers.</p>
  <a href="${profileUrl}" style="display:inline-block;padding:10px 24px;background:#d97706;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Review Profile</a>
</div>`,
      )
      return
    }

    if (target.status === 'rejected') {
      const profileUrl = `${config.CLIENT_URL}/profile-registration`
      await sendEmail(
        target.profile.email,
        `Action required: seller profile verification — ${platformName}`,
        `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
  <h2 style="color:#dc2626;margin:0 0 12px;">Profile Verification Update</h2>
  <p style="color:#374151;margin:0 0 12px;">Hi ${sellerName},</p>
  <p style="color:#374151;margin:0 0 12px;">We reviewed your seller profile on <strong>${platformName}</strong> and it requires updates before approval.</p>
  <div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px 16px;border-radius:4px;margin:16px 0;">
    <strong style="color:#b91c1c;font-size:13px;">Message from admin:</strong>
    <p style="color:#7f1d1d;margin:8px 0 0;font-size:14px;white-space:pre-wrap;">${target.reason || 'No reason provided.'}</p>
  </div>
  <a href="${profileUrl}" style="display:inline-block;padding:10px 24px;background:#dc2626;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Update Profile</a>
</div>`,
      )
      return
    }

    await sendEmail(
      target.profile.email,
      `Your seller account has been suspended — ${platformName}`,
      `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
  <h2 style="color:#ea580c;margin:0 0 12px;">Account Suspended</h2>
  <p style="color:#374151;margin:0 0 12px;">Hi ${sellerName},</p>
  <p style="color:#374151;margin:0 0 12px;">Your seller account on <strong>${platformName}</strong> has been <strong style="color:#ea580c;">suspended</strong>.</p>
  <div style="background:#fff7ed;border-left:4px solid #ea580c;padding:12px 16px;border-radius:4px;margin:16px 0;">
    <strong style="color:#c2410c;font-size:13px;">Reason:</strong>
    <p style="color:#7c2d12;margin:8px 0 0;font-size:14px;white-space:pre-wrap;">${target.reason || 'No reason provided.'}</p>
  </div>
  <p style="color:#374151;margin:0 0 20px;">While suspended, your products are hidden from customers and you cannot list new products.</p>
</div>`,
    )
  } catch (emailErr) {
    console.error('Seller status email failed (non-blocking):', emailErr)
  }
}

const validateAdminSellerStatusPayload = (profileIdRaw: unknown, statusRaw: unknown, reasonRaw: unknown) => {
  const profileId = Number(profileIdRaw)
  const status = normalizeSellerProfileStatus(statusRaw)
  const reason = String(reasonRaw || '').trim()

  if (!Number.isFinite(profileId) || profileId <= 0) {
    return { error: 'Invalid profile id' as const }
  }

  if (!status) {
    return { error: 'Invalid seller status' as const }
  }

  if (status !== 'verified' && !reason) {
    return { error: 'Reason is required unless the status is Verified' as const }
  }

  return { profileId, status, reason }
}

// ===== Admin Update Profile Status =====
app.post('/api/admin/profiles/:id/status', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const parsed = validateAdminSellerStatusPayload(req.params.id, req.body?.status, req.body?.reason)
  if ('error' in parsed) {
    return res.status(400).json({ message: parsed.error })
  }

  try {
    const result = await updateSellerProfileStatus(parsed.profileId, parsed.status, parsed.reason)
    if (!result) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    await notifySellerProfileStatusChange(parsed.profileId, result)

    return res.status(200).json({
      message: `Profile status updated to ${parsed.status}`,
      profile_id: parsed.profileId,
      status: parsed.status,
      status_reason: result.reason,
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Approve Profile =====
app.post('/api/admin/profiles/:id/approve', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const profileId = Number(req.params.id)
  if (!Number.isFinite(profileId) || profileId <= 0) {
    return res.status(400).json({ message: 'Invalid profile id' })
  }

  try {
    const result = await updateSellerProfileStatus(profileId, 'verified')
    if (!result) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    await notifySellerProfileStatusChange(profileId, result)
    res.status(200).json({ message: 'Profile approved', status: 'verified' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Verify Seller (by user id) =====
app.post('/api/admin/sellers/:sellerId/verify', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const sellerId = Number(req.params.sellerId)
  if (!Number.isFinite(sellerId) || sellerId <= 0) {
    return res.status(400).json({ message: 'Invalid seller id' })
  }

  try {
    await ensureProfilesStatusColumns()

    const [users] = await db.query<RowDataPacket[]>(
      "SELECT id, role, email FROM users WHERE id = ? LIMIT 1",
      [sellerId],
    )

    if (users.length === 0) {
      return res.status(404).json({ message: 'Seller not found' })
    }

    if (users[0].role !== 'seller') {
      return res.status(400).json({ message: 'User is not a seller' })
    }

    const [profiles] = await db.query<RowDataPacket[]>(
      `SELECT id
       FROM profiles
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sellerId],
    )

    if (profiles.length > 0) {
      const result = await updateSellerProfileStatus(Number(profiles[0].id), 'verified')
      if (!result) {
        return res.status(404).json({ message: 'Profile not found' })
      }

      await notifySellerProfileStatusChange(Number(profiles[0].id), result)
      return res.status(200).json({ message: 'Seller verified', profile_id: profiles[0].id, status: 'verified' })
    }

    const [insertResult] = await db.query<ResultSetHeader>(
      "INSERT INTO profiles (user_id, profile_type, status, status_reason, is_verified, is_blocked, rejection_reason, blocked_reason) VALUES (?, 'private', 'verified', NULL, 1, 0, NULL, NULL)",
      [sellerId],
    )

    await notifySellerProfileStatusChange(insertResult.insertId, {
      profile: {
        user_id: sellerId,
        email: users[0].email,
        seller_name: String(users[0].email || 'Seller').split('@')[0],
      } as RowDataPacket,
      status: 'verified',
      reason: null,
    })

    return res.status(200).json({ message: 'Seller verified', profile_id: insertResult.insertId, status: 'verified' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Reject Profile =====
app.post('/api/admin/profiles/:id/reject', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const parsed = validateAdminSellerStatusPayload(req.params.id, 'rejected', req.body?.reason)
  if ('error' in parsed) {
    return res.status(400).json({ message: parsed.error })
  }

  try {
    const result = await updateSellerProfileStatus(parsed.profileId, 'rejected', parsed.reason)
    if (!result) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    await notifySellerProfileStatusChange(parsed.profileId, result)
    res.status(200).json({ message: 'Profile rejected', status: 'rejected', status_reason: result.reason })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Block Seller =====
app.post('/api/admin/profiles/:id/block', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const parsed = validateAdminSellerStatusPayload(req.params.id, 'blocked', req.body?.reason)
  if ('error' in parsed) {
    return res.status(400).json({ message: parsed.error })
  }

  try {
    const result = await updateSellerProfileStatus(parsed.profileId, 'blocked', parsed.reason)
    if (!result) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    await notifySellerProfileStatusChange(parsed.profileId, result)
    res.status(200).json({ message: 'Seller blocked', status: 'blocked', status_reason: result.reason })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Unblock Seller =====
app.post('/api/admin/profiles/:id/unblock', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const profileId = Number(req.params.id)
  if (!Number.isFinite(profileId) || profileId <= 0) {
    return res.status(400).json({ message: 'Invalid profile id' })
  }

  try {
    const result = await updateSellerProfileStatus(profileId, 'verified')
    if (!result) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    await notifySellerProfileStatusChange(profileId, result)
    res.status(200).json({ message: 'Seller unblocked', status: 'verified' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Delete Profile =====
app.delete('/api/admin/profiles/:id', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const profileId = Number(req.params.id)

  if (!Number.isFinite(profileId) || profileId <= 0) {
    return res.status(400).json({ message: 'Invalid profile id' })
  }

  try {
    // Get the user_id from the profile to delete the user as well
    const [profiles] = await db.query<RowDataPacket[]>(
      'SELECT user_id FROM profiles WHERE id = ?',
      [profileId],
    )

    if (profiles.length === 0) {
      return res.status(404).json({ message: 'Profile not found' })
    }

    const userId = profiles[0].user_id

    // Delete the user (will cascade delete the profile)
    const [result] = await db.query<ResultSetHeader>(
      'DELETE FROM users WHERE id = ?',
      [userId],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' })
    }

    res.status(200).json({ message: 'Seller account deleted' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Delete Seller (by user id) =====
app.delete('/api/admin/sellers/:sellerId', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const sellerId = Number(req.params.sellerId)
  if (!Number.isFinite(sellerId) || sellerId <= 0) {
    return res.status(400).json({ message: 'Invalid seller id' })
  }

  try {
    const [users] = await db.query<RowDataPacket[]>(
      'SELECT id, role FROM users WHERE id = ? LIMIT 1',
      [sellerId],
    )

    if (!users.length) {
      return res.status(404).json({ message: 'Seller not found' })
    }

    const user = users[0]
    if (String(user.role || '') !== 'seller') {
      return res.status(400).json({ message: 'Target user is not a seller' })
    }

    const [result] = await db.query<ResultSetHeader>(
      'DELETE FROM users WHERE id = ?',
      [sellerId],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Seller not found' })
    }

    return res.status(200).json({ message: 'Seller account deleted' })
  } catch (error) {
    console.error('Failed to delete seller by id:', error)
    return res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Approve Product =====
app.post('/api/admin/products/:id/approve', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const productId = Number(req.params.id)
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id' })
  }

  try {
    const [productRows] = await db.query<RowDataPacket[]>(
      'SELECT seller_id, name FROM products WHERE id = ? LIMIT 1',
      [productId],
    )

    const hasRejectionMessageColumn = await hasProductRejectionMessageColumn()
    const approveSql = hasRejectionMessageColumn
      ? "UPDATE products SET approval_status = 'approved', rejection_message = NULL WHERE id = ?"
      : "UPDATE products SET approval_status = 'approved' WHERE id = ?"

    const [result] = await db.query<ResultSetHeader>(
      approveSql,
      [productId],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (productRows.length > 0) {
      emitToSeller(Number(productRows[0].seller_id), 'product:approved', {
        product_id: productId,
        seller_id: Number(productRows[0].seller_id),
        product_name: String(productRows[0].name || ''),
      })
      emitToAdmin('product:approved', {
        product_id: productId,
        seller_id: Number(productRows[0].seller_id),
        product_name: String(productRows[0].name || ''),
      })
    }

    res.status(200).json({ message: 'Product approved' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Reject Product =====
app.post('/api/admin/products/:id/reject', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const productId = Number(req.params.id)
  const rejectionMessage = String(req.body?.message || '').trim()

  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id' })
  }

  if (!rejectionMessage) {
    return res.status(400).json({ message: 'Rejection message is required' })
  }

  try {
    const [productRows] = await db.query<RowDataPacket[]>(
      'SELECT seller_id, name FROM products WHERE id = ? LIMIT 1',
      [productId],
    )

    const hasRejectionMessageColumn = await hasProductRejectionMessageColumn()
    const rejectSql = hasRejectionMessageColumn
      ? "UPDATE products SET approval_status = 'rejected', rejection_message = ? WHERE id = ?"
      : "UPDATE products SET approval_status = 'rejected' WHERE id = ?"
    const rejectParams = hasRejectionMessageColumn ? [rejectionMessage, productId] : [productId]

    const [result] = await db.query<ResultSetHeader>(rejectSql, rejectParams)

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (productRows.length > 0) {
      emitToSeller(Number(productRows[0].seller_id), 'product:rejected', {
        product_id: productId,
        seller_id: Number(productRows[0].seller_id),
        product_name: String(productRows[0].name || ''),
        rejection_message: rejectionMessage,
      })
      emitToAdmin('product:rejected', {
        product_id: productId,
        seller_id: Number(productRows[0].seller_id),
        product_name: String(productRows[0].name || ''),
      })
    }

    res.status(200).json({ message: 'Product rejected', rejection_message: rejectionMessage })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Admin Approve Monthly Seller Payout =====
app.post('/api/admin/payments/approve', async (req: Request, res: Response) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  const sellerId = Number(req.body?.seller_id)
  const year = Number(req.body?.year)
  const month = Number(req.body?.month)
  const reference = String(req.body?.reference || '').trim()

  if (!Number.isFinite(sellerId) || sellerId <= 0) {
    return res.status(400).json({ message: 'Invalid seller_id' })
  }
  if (!Number.isFinite(year) || year < 2000 || year > 9999) {
    return res.status(400).json({ message: 'Invalid year' })
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ message: 'Invalid month' })
  }
  if (!reference) {
    return res.status(400).json({ message: 'Payment reference is required' })
  }

  try {
    await ensureSalesPayoutColumns()
    const [paymentDateColumnExists, payoutReferenceColumnExists] = await Promise.all([
      hasSalesPayoutPaymentDateColumn(),
      hasSalesPayoutReferenceColumn(),
    ])

    const updates: string[] = ["payout_status = 'paid'"]
    const values: any[] = []
    const paymentDate = toCETDateTime()

    if (paymentDateColumnExists) {
      updates.push('payout_payment_date = ?')
      values.push(paymentDate)
    }

    if (payoutReferenceColumnExists) {
      updates.push('payout_reference = ?')
      values.push(reference)
    }

    values.push(sellerId, year, month)

    const [result] = await db.query<ResultSetHeader>(
      `UPDATE sales
       SET ${updates.join(', ')}
       WHERE seller_id = ?
         AND YEAR(order_date) = ?
         AND MONTH(order_date) = ?
         AND payout_status = 'unpaid'`,
      values,
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'No unpaid records found for this seller/month' })
    }

    emitToSeller(sellerId, 'payout:approved', {
      seller_id: sellerId,
      year,
      month,
      reference,
      payout_payment_date: paymentDate,
      affected_orders: result.affectedRows,
    })
    emitToAdmin('payment:processed', {
      seller_id: sellerId,
      year,
      month,
      reference,
      affected_orders: result.affectedRows,
    })

    res.status(200).json({
      message: 'Monthly payout approved',
      affected_orders: result.affectedRows,
      payout_payment_date: paymentDateColumnExists ? paymentDate : null,
      payout_reference: payoutReferenceColumnExists ? reference : null,
    })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Product Registration Route =====
app.post('/api/products', productUpload, async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  // Only verified sellers can create products.
  try {
    await ensureProfilesStatusColumns()
    const [profileCheck] = await db.query<RowDataPacket[]>(
      'SELECT status, status_reason, is_verified, rejection_reason, is_blocked, blocked_reason FROM profiles WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [auth.id],
    )

    if (profileCheck.length === 0) {
      return res.status(403).json({ message: 'Your seller profile is pending review. Complete your profile and wait for admin approval before registering products.' })
    }

    const sellerStatus = getSellerProfileStatus(profileCheck[0])
    const sellerStatusReason = getSellerProfileStatusReason(profileCheck[0])

    if (sellerStatus !== 'verified') {
      const fallbackMessage = sellerStatus === 'blocked'
        ? 'Your account has been suspended. You cannot register products.'
        : sellerStatus === 'rejected'
        ? 'Your profile has been rejected. Please update your profile before registering products.'
        : 'Your seller profile is pending review. You cannot register products until it is verified.'

      return res.status(403).json({
        message: sellerStatusReason || fallbackMessage,
        status: sellerStatus,
      })
    }
  } catch (profileCheckErr) {
    console.error('Profile status check failed:', profileCheckErr)
  }

  console.log('Product registration:', req.body)
  const uploadedFiles = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
  console.log('Files uploaded:', {
    images: uploadedFiles?.images?.length || 0,
    variant_images: uploadedFiles?.variant_images?.length || 0,
    variant_files: uploadedFiles?.variant_files?.length || 0,
    digital_file: uploadedFiles?.digital_file?.length || 0,
  })

  const {
    name,
    subtitle,
    description,
    category,
    age_category,
    brand,
    price,
    discount_price,
    stock_quantity,
    item_condition,
    status,
    type,
    tax_class,
    approval_status,
    metadata,
    variants,
  } = req.body

  const imageFiles = uploadedFiles?.images || []
  const variantImageFiles = uploadedFiles?.variant_images || []
  const variantFiles = uploadedFiles?.variant_files || []
  if (!name || !category) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const skuColumnExists = await hasProductSkuColumn()

    const productData: any = {
      seller_id: auth.id,
      name,
      subtitle: subtitle || null,
      description: description || null,
      category,
      brand: brand || null,
      age_category: age_category || null,
      item_condition: item_condition || 'new',
      tax_class: tax_class || 'standard',
      approval_status: approval_status || 'pending',
      status: status || 'active',
    }

    if (skuColumnExists) {
      productData.sku = await generateUniqueProductSku(auth.id, name)
    }

    console.log('Parsing variants with:', { variants, metadata, price, discount_price, stock_quantity, type })

    let normalizedVariants: NormalizedVariant[] = []
    try {
      normalizedVariants = normalizeVariantsFromRequest(variants ?? metadata, {
        price,
        discount_price,
        stock_quantity,
        type,
      })
    } catch (parseErr) {
      console.error('Error parsing variants:', parseErr)
      return res.status(400).json({
        error: 'Invalid variant data format',
        details: parseErr instanceof Error ? parseErr.message : String(parseErr)
      })
    }

    console.log('Normalized variants:', normalizedVariants)

    if (normalizedVariants.length === 0) {
      return res.status(400).json({ error: 'At least one variant is required' })
    }

    const resolvedProductType: 'digital' | 'physical' =
      type === 'digital' || normalizedVariants.some((variant) => variant.type === 'digital')
        ? 'digital'
        : 'physical'
    normalizedVariants = normalizedVariants.map((variant) => ({
      ...variant,
      type: resolvedProductType,
    }))
    productData.type = resolvedProductType

    // Check if seller exists
    const [sellerExists] = await db.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ?', [auth.id]
    )
    if (sellerExists.length === 0) {
      console.error(`Seller with ID ${auth.id} does not exist`)
      return res.status(400).json({ error: `Seller account not found. Please ensure your user exists in the system.` })
    }

    // Process variant images if uploaded
    const variantImagesMap: { [key: string]: string } = {}
    if (variantImageFiles.length > 0) {
      let variantImageIndicesRaw = req.body.variant_image_indices
      let variantImageIndices: string[] = []

      try {
        if (variantImageIndicesRaw) {
          if (typeof variantImageIndicesRaw === 'string') {
            variantImageIndices = JSON.parse(variantImageIndicesRaw)
          } else if (Array.isArray(variantImageIndicesRaw)) {
            variantImageIndices = variantImageIndicesRaw
          }
        }
      } catch (e) {
        console.warn('Could not parse variant_image_indices:', e)
      }

      for (let i = 0; i < variantImageFiles.length; i++) {
        const file = variantImageFiles[i]
        const imageUrl = `/uploads/products/${file.filename}`
        const variantIndex = variantImageIndices[i] || i
        variantImagesMap[variantIndex] = imageUrl
      }
    }

    // Process variant files if uploaded
    const variantFilesMap: { [key: string]: string } = {}
    if (variantFiles.length > 0) {
      let variantFileIndicesRaw = req.body.variant_file_indices
      let variantFileIndices: string[] = []

      try {
        if (variantFileIndicesRaw) {
          if (typeof variantFileIndicesRaw === 'string') {
            variantFileIndices = JSON.parse(variantFileIndicesRaw)
          } else if (Array.isArray(variantFileIndicesRaw)) {
            variantFileIndices = variantFileIndicesRaw
          }
        }
      } catch (e) {
        console.warn('Could not parse variant_file_indices:', e)
      }

      for (let i = 0; i < variantFiles.length; i++) {
        const file = variantFiles[i]
        const fileUrl = `/uploads/products/${file.filename}`
        const variantIndex = variantFileIndices[i] || i
        variantFilesMap[variantIndex] = fileUrl
      }
    }

    const [result] = await db.query<ResultSetHeader>('INSERT INTO products SET ?', productData)
    console.log('Product inserted with ID:', result.insertId)

    emitToAdmin('notification:new', {
      entity: 'product',
      action: 'created',
      product_id: result.insertId,
      seller_id: auth.id,
      product_name: name,
    })

    for (let i = 0; i < normalizedVariants.length; i++) {
      const variant = normalizedVariants[i]
      const sku = variant.sku || await generateVariantSku(auth.id, name, variant.variant_value)
      const variantImageUrl = variantImagesMap[i] || variant.image_url || null
      const variantFileUrl = variantFilesMap[i] || variant.file_url || null

      console.log(`Inserting variant ${i}:`, {
        variant_name: variant.variant_name,
        variant_value: variant.variant_value,
        price: variant.price,
        discount_price: variant.discount_price,
        stock_quantity: variant.stock_quantity,
        type: variant.type,
        image_url: variantImageUrl,
        file_url: variantFileUrl,
      })

      try {
        await db.query(
          `INSERT INTO product_variants (
            product_id, variant_name, variant_value, sku, price, discount_price,
            stock_quantity, length_cm, width_cm, height_cm, weight_kg, type, image_url, file_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            result.insertId,
            variant.variant_name,
            variant.variant_value,
            sku,
            variant.price,
            variant.discount_price,
            variant.stock_quantity,
            variant.length_cm,
            variant.width_cm,
            variant.height_cm,
            variant.weight_kg,
            variant.type,
            variantImageUrl,
            variantFileUrl,
          ],
        )
        console.log(`Variant ${i} inserted successfully`)
      } catch (variantErr) {
        console.error(`Error inserting variant ${i}:`, variantErr)
        throw variantErr
      }
    }

    if (imageFiles.length > 0) {
      const imagesMainRaw = req.body.images_main
      // Frontend sends a single comma-separated string, e.g. "1,0,0"
      const imagesMain: string[] = Array.isArray(imagesMainRaw)
        ? imagesMainRaw
        : typeof imagesMainRaw === 'string' && imagesMainRaw.includes(',')
          ? imagesMainRaw.split(',')
          : imagesMainRaw
            ? [imagesMainRaw]
            : []

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]
        const imageUrl = `/uploads/products/${file.filename}`
        const isMain = imagesMain[i] === '1' || (i === 0 && !imagesMain.some((m: string) => m === '1'))

        await db.query('INSERT INTO product_images (product_id, image_url, is_main) VALUES (?, ?, ?)', [
          result.insertId,
          imageUrl,
          isMain,
        ])

        if (isMain) {
          await db.query('UPDATE products SET main_image_url = ? WHERE id = ?', [imageUrl, result.insertId])
        }
      }
    }

    res.status(201).json({ id: result.insertId, ...productData })
  } catch (err) {
    console.error('Error registering product:', err)
    if (err instanceof Error) {
      console.error('Error stack:', err.stack)
    }
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({
      error: 'Failed to register product',
      details: errorMessage,
      stack: config.NODE_ENV === 'development' ? (err instanceof Error ? err.stack : null) : undefined
    })
  }
})

// ===== Update Product =====
app.put('/api/products/:id', productUpload, async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id
  console.log('Product update:', req.body)

  const {
    name,
    subtitle,
    description,
    category,
    age_category,
    brand,
    price,
    discount_price,
    stock_quantity,
    item_condition,
    type,
    tax_class,
    approval_status,
    status,
    metadata,
    variants,
  } = req.body
  const uploadedFiles = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
  const imageFiles = uploadedFiles?.images || []
  const variantImageFiles = uploadedFiles?.variant_images || []
  const variantFiles = uploadedFiles?.variant_files || []

  if (!name || !category) {
    return res.status(400).json({ message: 'Required fields are missing' })
  }

  try {
    // Check if product exists and belongs to the user
    const [products] = await db.query<RowDataPacket[]>(
      'SELECT id, seller_id FROM products WHERE id = ?',
      [productId]
    )

    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (products[0].seller_id !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to update this product' })
    }

    const hasRejectionMessageColumn = await hasProductRejectionMessageColumn()
    const updateProductQuery = hasRejectionMessageColumn
      ? `UPDATE products SET
        name = ?, subtitle = ?, description = ?, category = ?, brand = ?,
        age_category = ?, item_condition = ?, tax_class = ?,
        approval_status = 'pending', rejection_message = NULL, status = ?, type = ?
      WHERE id = ?`
      : `UPDATE products SET
        name = ?, subtitle = ?, description = ?, category = ?, brand = ?,
        age_category = ?, item_condition = ?, tax_class = ?,
        approval_status = 'pending', status = ?, type = ?
      WHERE id = ?`

    await db.query(updateProductQuery,
      [
        name,
        subtitle || null,
        description || null,
        category,
        brand || null,
        age_category || null,
        item_condition || 'new',
        tax_class || 'standard',
        status || 'active',
        type === 'digital' ? 'digital' : 'physical',
        productId,
      ],
    )

    const shouldReplaceVariants = variants != null || metadata != null
    if (shouldReplaceVariants) {
      const normalizedVariantsRaw = normalizeVariantsFromRequest(variants ?? metadata, {
        price,
        discount_price,
        stock_quantity,
        type,
      })

      const resolvedProductType: 'digital' | 'physical' = type === 'digital' ? 'digital' : 'physical'
      const normalizedVariants = normalizedVariantsRaw.map((variant) => ({
        ...variant,
        type: resolvedProductType,
      }))

      if (normalizedVariants.length === 0) {
        return res.status(400).json({ message: 'At least one variant is required' })
      }

      // Process variant images if uploaded
      const variantImagesMap: { [key: string]: string } = {}
      if (variantImageFiles.length > 0) {
        let variantImageIndicesRaw = req.body.variant_image_indices
        let variantImageIndices: string[] = []

        try {
          if (variantImageIndicesRaw) {
            if (typeof variantImageIndicesRaw === 'string') {
              variantImageIndices = JSON.parse(variantImageIndicesRaw)
            } else if (Array.isArray(variantImageIndicesRaw)) {
              variantImageIndices = variantImageIndicesRaw
            }
          }
        } catch (e) {
          console.warn('Could not parse variant_image_indices:', e)
        }

        for (let i = 0; i < variantImageFiles.length; i++) {
          const file = variantImageFiles[i]
          const imageUrl = `/uploads/products/${file.filename}`
          const variantIndex = variantImageIndices[i] || i
          variantImagesMap[variantIndex] = imageUrl
        }
      }

      // Process variant files if uploaded
      const variantFilesMap: { [key: string]: string } = {}
      if (variantFiles.length > 0) {
        let variantFileIndicesRaw = req.body.variant_file_indices
        let variantFileIndices: string[] = []

        try {
          if (variantFileIndicesRaw) {
            if (typeof variantFileIndicesRaw === 'string') {
              variantFileIndices = JSON.parse(variantFileIndicesRaw)
            } else if (Array.isArray(variantFileIndicesRaw)) {
              variantFileIndices = variantFileIndicesRaw
            }
          }
        } catch (e) {
          console.warn('Could not parse variant_file_indices:', e)
        }

        for (let i = 0; i < variantFiles.length; i++) {
          const file = variantFiles[i]
          const fileUrl = `/uploads/products/${file.filename}`
          const variantIndex = variantFileIndices[i] || i
          variantFilesMap[variantIndex] = fileUrl
        }
      }

      await db.query('DELETE FROM product_variants WHERE product_id = ?', [productId])

      for (let i = 0; i < normalizedVariants.length; i++) {
        const variant = normalizedVariants[i]
        const sku = variant.sku || await generateVariantSku(auth.id, name, variant.variant_value)
        const variantImageUrl = variantImagesMap[i] || variant.image_url || null
        const variantFileUrl = variantFilesMap[i] || variant.file_url || null

        await db.query(
          `INSERT INTO product_variants (
            product_id, variant_name, variant_value, sku, price, discount_price,
            stock_quantity, length_cm, width_cm, height_cm, weight_kg, type, image_url, file_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            productId,
            variant.variant_name,
            variant.variant_value,
            sku,
            variant.price,
            variant.discount_price,
            variant.stock_quantity,
            variant.length_cm,
            variant.width_cm,
            variant.height_cm,
            variant.weight_kg,
            variant.type,
            variantImageUrl,
            variantFileUrl,
          ],
        )
      }
    }

    // Handle images if new ones are uploaded
    if (imageFiles.length > 0) {
      // Delete old product images
      await db.query('DELETE FROM product_images WHERE product_id = ?', [productId])

      const imagesMainRaw = req.body.images_main
      // Frontend sends a single comma-separated string, e.g. "1,0,0"
      const imagesMain: string[] = Array.isArray(imagesMainRaw)
        ? imagesMainRaw
        : typeof imagesMainRaw === 'string' && imagesMainRaw.includes(',')
          ? imagesMainRaw.split(',')
          : imagesMainRaw
            ? [imagesMainRaw]
            : []

      // Insert new product images
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]
        const imageUrl = `/uploads/products/${file.filename}`
        const isMain = imagesMain[i] === '1' || (i === 0 && !imagesMain.some((m: string) => m === '1'))

        await db.query(
          'INSERT INTO product_images (product_id, image_url, is_main) VALUES (?, ?, ?)',
          [productId, imageUrl, isMain],
        )

        // Update main_image_url in products table if this is the main image
        if (isMain) {
          await db.query('UPDATE products SET main_image_url = ? WHERE id = ?', [imageUrl, productId])
        }
      }
    }

    res.status(200).json({
      id: productId,
      message: 'Product updated successfully',
    })

    emitToAdmin('notification:new', {
      entity: 'product',
      action: 'updated',
      product_id: Number(productId),
      seller_id: auth.id,
      product_name: name,
    })
  } catch (err) {
    console.error('Error updating product:', err)
    const errorMessage = err instanceof Error ? err.message : String(err)
    res.status(500).json({ message: 'Failed to update product', details: errorMessage })
  }
})

// ===== Get Products =====
app.get('/api/products', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const skuColumnExists = await hasProductSkuColumn()
    const skuSelect = skuColumnExists ? 'p.sku' : 'NULL as sku'
    const rejectionMessageColumnExists = await hasProductRejectionMessageColumn()
    const rejectionMessageSelect = rejectionMessageColumnExists
      ? 'p.rejection_message'
      : 'NULL as rejection_message'
    const isPromotedColumnExists = await hasProductIsPromotedColumn()
    const isPromotedSelect = isPromotedColumnExists ? 'p.is_promoted' : 'FALSE as is_promoted'
    const [roleRows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    const isAdmin = roleRows.length > 0 && roleRows[0].role === 'admin'
    const whereClause = isAdmin ? '' : 'WHERE p.seller_id = ?'
    const queryParams = isAdmin ? [] : [auth.id]

    const [products] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.seller_id,
        p.name,
        ${skuSelect},
        p.subtitle,
        p.description,
        p.category,
        p.brand,
        p.age_category,
        p.item_condition,
        p.tax_class,
        p.approval_status,
        ${rejectionMessageSelect},
        ${isPromotedSelect},
        p.main_image_url,
        p.status,
        p.created_at,
        p.updated_at,
        GROUP_CONCAT(pi.image_url) as image_urls
      FROM products p
      LEFT JOIN product_images pi ON p.id = pi.product_id
      LEFT JOIN users u ON p.seller_id = u.id
      ${whereClause}
      GROUP BY p.id
      ORDER BY p.created_at DESC`,
      queryParams
    )

    const productIds = products.map((p) => p.id)
    const variantsByProduct = new Map<number, RowDataPacket[]>()

    if (productIds.length > 0) {
      const [variantRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM product_variants WHERE product_id IN (?) ORDER BY id ASC',
        [productIds],
      )

      for (const row of variantRows) {
        const list = variantsByProduct.get(row.product_id) || []
        list.push(row)
        variantsByProduct.set(row.product_id, list)
      }
    }

    const response = products.map((product) => {
      const rows = variantsByProduct.get(product.id) || []
      const grouped: Record<string, any[]> = {}

      for (const row of rows) {
        if (!grouped[row.variant_name]) grouped[row.variant_name] = []
        grouped[row.variant_name].push({
          value: row.variant_value,
          stock: Number(row.stock_quantity || 0),
          sku: row.sku,
          length: row.length_cm,
          width: row.width_cm,
          height: row.height_cm,
          weight: row.weight_kg,
          price: row.price,
          discount_price: row.discount_price,
          type: row.type,
          image: row.image_url,
          file: row.file_url,
        })
      }

      const metadata = {
        variants: Object.entries(grouped).map(([className, values]) => ({ className, values })),
      }

      const stock_quantity = rows.reduce((sum, r) => sum + Number(r.stock_quantity || 0), 0)
      const minPrice = rows.length > 0 ? Math.min(...rows.map((r) => Number(r.price || 0))) : null
      const discountCandidates = rows
        .map((r) => (r.discount_price == null ? null : Number(r.discount_price)))
        .filter((value): value is number => value != null)
      const minDiscount = discountCandidates.length > 0 ? Math.min(...discountCandidates) : null
      const primary = rows[0]

      return {
        ...product,
        type: primary?.type || 'physical',
        tax_class: product.tax_class || null,
        price: minPrice,
        discount_price: minDiscount,
        stock_quantity,
        length_cm: primary?.length_cm ?? null,
        width_cm: primary?.width_cm ?? null,
        height_cm: primary?.height_cm ?? null,
        weight_kg: primary?.weight_kg ?? null,
        digital_product_url: null,
        metadata: JSON.stringify(metadata),
      }
    })

    res.status(200).json(response)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Public Products (No Auth Required) =====
app.get('/api/public/products', async (req: Request, res: Response) => {
  try {
    await ensureProfilesStatusColumns()
    const pageRaw = Number(req.query.page)
    const limitRaw = Number(req.query.limit)
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 60) : 24
    const offset = (page - 1) * limit

    const [countRows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM products p
       LEFT JOIN users u ON p.seller_id = u.id
       LEFT JOIN profiles sp ON sp.id = (
         SELECT p2.id FROM profiles p2 WHERE p2.user_id = u.id ORDER BY p2.created_at DESC, p2.id DESC LIMIT 1
       )
      WHERE p.status = 'active'
        AND p.approval_status = 'approved'
        AND COALESCE(sp.status, 'pending') = 'verified'`,
    )
    const total = Number(countRows[0]?.total || 0)

    const [products] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.seller_id,
        p.name,
        p.subtitle,
        p.description,
        p.category,
        p.brand,
        p.age_category,
        p.item_condition,
        p.tax_class,
        p.main_image_url,
        p.status,
        p.created_at,
        p.updated_at,
        u.email as seller_email,
        MAX(COALESCE(NULLIF(TRIM(sp.display_name), ''), NULLIF(TRIM(sp.company_name), ''), SUBSTRING_INDEX(u.email, '@', 1))) as seller_display_name,
        GROUP_CONCAT(pi.image_url ORDER BY pi.is_main DESC) as image_urls
      FROM products p
      LEFT JOIN product_images pi ON p.id = pi.product_id
      LEFT JOIN users u ON p.seller_id = u.id
      LEFT JOIN profiles sp ON sp.id = (
        SELECT p2.id
        FROM profiles p2
        WHERE p2.user_id = u.id
        ORDER BY p2.created_at DESC, p2.id DESC
        LIMIT 1
      )
      WHERE p.status = 'active'
        AND p.approval_status = 'approved'
        AND COALESCE(sp.status, 'pending') = 'verified'
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?`,
      [limit, offset],
    )

    const productIds = products.map((p) => p.id)
    const variantsByProduct = new Map<number, RowDataPacket[]>()

    if (productIds.length > 0) {
      const [variantRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM product_variants WHERE product_id IN (?) ORDER BY id ASC',
        [productIds],
      )

      for (const row of variantRows) {
        const list = variantsByProduct.get(row.product_id) || []
        list.push(row)
        variantsByProduct.set(row.product_id, list)
      }
    }

    const response = products
      .map((product) => {
        const rows = variantsByProduct.get(product.id) || []
        const grouped: Record<string, any[]> = {}
        const taxRate = parseTaxRateFromDbValue(product.tax_class)

        for (const row of rows) {
          if (!grouped[row.variant_name]) grouped[row.variant_name] = []
          grouped[row.variant_name].push({
            id: row.id,
            value: row.variant_value,
            stock: Number(row.stock_quantity || 0),
            sku: row.sku,
            length: row.length_cm,
            width: row.width_cm,
            height: row.height_cm,
            weight: row.weight_kg,
            price: row.price,
            discount_price: row.discount_price,
            type: row.type,
            image: row.image_url,
            file: row.file_url,
          })
        }

        const metadata = {
          variants: Object.entries(grouped).map(([className, values]) => ({ className, values })),
        }

        const stock_quantity = rows.reduce((sum, r) => sum + Number(r.stock_quantity || 0), 0)
        const minPrice = rows.length > 0 ? Math.min(...rows.map((r) => Number(r.price || 0))) : null
        const discountCandidates = rows
          .map((r) => (r.discount_price == null ? null : Number(r.discount_price)))
          .filter((value): value is number => value != null)
        const minDiscount = discountCandidates.length > 0 ? Math.min(...discountCandidates) : null
        const primary = rows[0]

        return {
          ...product,
          type: primary?.type || 'physical',
          tax_rate: taxRate,
          price: minPrice,
          discount_price: minDiscount,
          stock_quantity,
          digital_product_url: null,
          metadata: JSON.stringify(metadata),
        }
      })
      .filter((product) => product.type === 'digital' || Number(product.stock_quantity || 0) > 0)

    const hasMore = offset + response.length < total

    res.status(200).json({
      products: response,
      page,
      limit,
      total,
      hasMore,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Promoted Products (No Auth Required) =====
app.get('/api/public/products/promoted', async (req: Request, res: Response) => {
  try {
    const [products] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.name,
        p.subtitle,
        p.category,
        p.main_image_url,
        p.tax_class,
        p.is_promoted,
        u.email AS seller_email,
        MAX(COALESCE(NULLIF(TRIM(sp.display_name), ''), NULLIF(TRIM(sp.company_name), ''), SUBSTRING_INDEX(u.email, '@', 1))) AS seller_display_name,
        MIN(pv.price) AS min_price,
        MIN(pv.discount_price) AS min_discount_price,
        MAX(pv.type) AS type
      FROM products p
      LEFT JOIN product_variants pv ON pv.product_id = p.id
      LEFT JOIN users u ON p.seller_id = u.id
      LEFT JOIN profiles sp ON sp.id = (
        SELECT p2.id FROM profiles p2 WHERE p2.user_id = u.id ORDER BY p2.created_at DESC, p2.id DESC LIMIT 1
      )
      WHERE p.status = 'active'
        AND p.approval_status = 'approved'
        AND p.is_promoted = TRUE
        AND COALESCE(sp.status, 'pending') = 'verified'
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT 8`,
    )

    const filtered = products.filter(
      (p) => p.type === 'digital' || p.min_price != null,
    )

    res.status(200).json(filtered)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Customer Product Fetch Aliases (No Auth Required) =====
app.get('/api/customer/products', (req: Request, res: Response) => {
  const queryIndex = req.originalUrl.indexOf('?')
  const query = queryIndex >= 0 ? req.originalUrl.substring(queryIndex) : ''
  return res.redirect(307, `/api/public/products${query}`)
})

app.get('/api/customer/products/promoted', (req: Request, res: Response) => {
  return res.redirect(307, '/api/public/products/promoted')
})

// ===== Get Public Website Reviews (No Auth Required) =====
app.get('/api/public/reviews', async (req: Request, res: Response) => {
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         wr.id,
         wr.rating,
         wr.title,
         wr.review,
         wr.created_at,
         COALESCE(
           NULLIF(pr.display_name, ''),
           NULLIF(CONCAT(COALESCE(pr.first_name,''), ' ', COALESCE(pr.last_name,'')), ' '),
           SUBSTRING_INDEX(u.email, '@', 1)
         ) AS reviewer_name,
         CASE
           WHEN pr.city IS NOT NULL AND pr.country IS NOT NULL
             THEN CONCAT(pr.city, ', ', pr.country)
           WHEN pr.city IS NOT NULL THEN pr.city
           WHEN pr.country IS NOT NULL THEN pr.country
           ELSE NULL
         END AS reviewer_location
       FROM website_reviews wr
       LEFT JOIN users u ON u.id = wr.user_id
       LEFT JOIN profiles pr ON pr.user_id = wr.user_id
       WHERE wr.is_approved = TRUE
       ORDER BY wr.rating DESC, wr.created_at DESC
       LIMIT 3`,
    )
    res.status(200).json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Delete Product =====
app.delete('/api/products/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id

  try {
    // Check if product exists and belongs to the user
    const [products] = await db.query<RowDataPacket[]>(
      'SELECT id, seller_id FROM products WHERE id = ?',
      [productId]
    )

    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    // Allow admins to delete any product; sellers can only delete their own
    const [roleRows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    const isAdmin = roleRows.length > 0 && roleRows[0].role === 'admin'

    if (!isAdmin && products[0].seller_id !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to delete this product' })
    }

    // Soft delete product by setting status to inactive
    await db.query('UPDATE products SET status = ? WHERE id = ?', ['inactive', productId])

    res.status(200).json({ message: 'Product deleted successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Restore Product (Admin only) =====
app.put('/api/products/:id/restore', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id

  try {
    const [roleRows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    const isAdmin = roleRows.length > 0 && roleRows[0].role === 'admin'

    if (!isAdmin) {
      return res.status(403).json({ message: 'Only admins can restore products' })
    }

    const [found] = await db.query<RowDataPacket[]>(
      'SELECT id, status FROM products WHERE id = ? LIMIT 1',
      [productId]
    )

    if (found.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (found[0].status !== 'inactive') {
      return res.status(400).json({ message: 'Product is not in trash' })
    }

    await db.query('UPDATE products SET status = ? WHERE id = ?', ['active', productId])

    res.status(200).json({ message: 'Product restored successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Permanent Delete Product (Admin only, only if never ordered) =====
app.delete('/api/products/:id/permanent', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id

  try {
    const [roleRows] = await db.query<RowDataPacket[]>('SELECT role FROM users WHERE id = ? LIMIT 1', [auth.id])
    const isAdmin = roleRows.length > 0 && roleRows[0].role === 'admin'

    if (!isAdmin) {
      return res.status(403).json({ message: 'Only admins can permanently delete products' })
    }

    const [products] = await db.query<RowDataPacket[]>(
      'SELECT id, status FROM products WHERE id = ? LIMIT 1',
      [productId],
    )

    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (products[0].status !== 'inactive') {
      return res.status(400).json({ message: 'Only products in trash can be permanently deleted' })
    }

    const [orderedRows] = await db.query<RowDataPacket[]>(
      'SELECT id FROM sale_items WHERE product_id = ? LIMIT 1',
      [productId],
    )

    if (orderedRows.length > 0) {
      return res.status(400).json({
        message: 'Cannot permanently delete this product because it has order history',
      })
    }

    await db.query('DELETE FROM products WHERE id = ?', [productId])

    res.status(200).json({ message: 'Product permanently deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Toggle Product Promotion =====
app.put('/api/products/:id/promote', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id

  try {
    const isPromotedColumnExists = await hasProductIsPromotedColumn()
    if (!isPromotedColumnExists) {
      return res.status(400).json({
        message: 'Product promotion is not available yet. Please run the latest database migration.',
      })
    }

    // Check if product exists and belongs to the user
    const [products] = await db.query<RowDataPacket[]>(
      'SELECT id, seller_id, is_promoted FROM products WHERE id = ?',
      [productId]
    )

    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    if (products[0].seller_id !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to promote this product' })
    }

    // Toggle promotion status
    const newStatus = !products[0].is_promoted
    await db.query('UPDATE products SET is_promoted = ? WHERE id = ?', [newStatus, productId])

    res.status(200).json({
      message: newStatus ? 'Product promoted successfully' : 'Product promotion removed successfully',
      is_promoted: newStatus
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Product by ID =====
app.get('/api/products/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const productId = req.params.id

  try {
    const [products] = await db.query<RowDataPacket[]>(
      `SELECT
        p.id,
        p.seller_id,
        p.name,
        p.sku,
        p.subtitle,
        p.description,
        p.category,
        p.brand,
        p.age_category,
        p.item_condition,
        p.tax_class,
        p.approval_status,
        p.main_image_url,
        p.status,
        p.created_at,
        p.updated_at,
        GROUP_CONCAT(pi.image_url ORDER BY pi.is_main DESC) as image_urls
      FROM products p
      LEFT JOIN product_images pi ON p.id = pi.product_id
      WHERE p.id = ?
      GROUP BY p.id`,
      [productId]
    )

    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' })
    }

    const product = products[0]

    const [variantRows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id ASC',
      [productId],
    )

    const grouped: Record<string, any[]> = {}
    for (const row of variantRows) {
      if (!grouped[row.variant_name]) grouped[row.variant_name] = []
      grouped[row.variant_name].push({
        value: row.variant_value,
        stock: Number(row.stock_quantity || 0),
        sku: row.sku,
        length: row.length_cm,
        width: row.width_cm,
        height: row.height_cm,
        weight: row.weight_kg,
        price: row.price,
        discount_price: row.discount_price,
        type: row.type,
        image: row.image_url,
        file: row.file_url,
      })
    }

    const metadata = {
      variants: Object.entries(grouped).map(([className, values]) => ({ className, values })),
    }

    const stock_quantity = variantRows.reduce((sum, r) => sum + Number(r.stock_quantity || 0), 0)
    const minPrice = variantRows.length > 0 ? Math.min(...variantRows.map((r) => Number(r.price || 0))) : null
    const discountCandidates = variantRows
      .map((r) => (r.discount_price == null ? null : Number(r.discount_price)))
      .filter((value): value is number => value != null)
    const minDiscount = discountCandidates.length > 0 ? Math.min(...discountCandidates) : null
    const primary = variantRows[0]

    res.status(200).json({
      ...product,
      type: primary?.type || 'physical',
      price: minPrice,
      discount_price: minDiscount,
      stock_quantity,
      length_cm: primary?.length_cm ?? null,
      width_cm: primary?.width_cm ?? null,
      height_cm: primary?.height_cm ?? null,
      weight_kg: primary?.weight_kg ?? null,
      digital_product_url: null,
      metadata: JSON.stringify(metadata),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Shipment Policy Routes =====

// GET seller's shipment policies
app.get('/api/seller/shipment-policies', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const hasVatRateColumn = await hasShipmentPolicyVatRateColumn()

    const [policies] = await db.query<RowDataPacket[]>(
      `SELECT id, seller_id, country, fee${hasVatRateColumn ? ', vat_rate' : ''}, created_at, updated_at
       FROM shipment_policies
       WHERE seller_id = ?
       ORDER BY country ASC`,
      [auth.id]
    )

    res.json(
      (policies || []).map((policy: any) => ({
        ...policy,
        fee: Number(policy.fee || 0),
        vat_rate: Number(hasVatRateColumn ? policy.vat_rate : VAT_SHIPPING_RATE * 100),
      }))
    )
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to fetch shipment policies' })
  }
})

// POST create or update shipment policies
app.post('/api/seller/shipment-policies', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const { policies } = req.body

  if (!Array.isArray(policies) || policies.length === 0) {
    return res.status(400).json({ message: 'Policies array is required' })
  }

  try {
    const hasVatRateColumn = await hasShipmentPolicyVatRateColumn()

    // Delete existing policies for this seller
    await db.query(
      'DELETE FROM shipment_policies WHERE seller_id = ?',
      [auth.id]
    )

    // Insert new policies
    for (const policy of policies) {
      if (!policy.country || policy.fee === null || policy.fee === undefined) {
        continue // Skip invalid entries
      }

      if (hasVatRateColumn) {
        await db.query(
          `INSERT INTO shipment_policies (seller_id, country, fee, vat_rate)
           VALUES (?, ?, ?, ?)`,
          [auth.id, policy.country, parseFloat(policy.fee), Number(policy.vat_rate ?? VAT_SHIPPING_RATE * 100)]
        )
      } else {
        await db.query(
          `INSERT INTO shipment_policies (seller_id, country, fee)
           VALUES (?, ?, ?)`,
          [auth.id, policy.country, parseFloat(policy.fee)]
        )
      }
    }

    res.status(201).json({
      message: 'Shipment policies saved successfully',
      count: policies.length
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to save shipment policies' })
  }
})

// GET shipment fee for a specific country
app.get('/api/shipment-fee', async (req: Request, res: Response) => {
  const { seller_id, country } = req.query

  if (!seller_id || !country) {
    return res.status(400).json({ message: 'seller_id and country are required' })
  }

  try {
    const hasVatRateColumn = await hasShipmentPolicyVatRateColumn()

    const [policies] = await db.query<RowDataPacket[]>(
      `SELECT fee${hasVatRateColumn ? ', vat_rate' : ''} FROM shipment_policies
       WHERE seller_id = ? AND country = ?
       LIMIT 1`,
      [seller_id, country]
    )

    // Return 0 if no policy found for this country
    if (policies.length === 0) {
      return res.status(200).json({ fee: 0, vat_rate: VAT_SHIPPING_RATE * 100, message: 'No shipment policy found for this country' })
    }

    res.status(200).json({
      fee: Number(policies[0].fee) || 0,
      vat_rate: Number(hasVatRateColumn ? policies[0].vat_rate : VAT_SHIPPING_RATE * 100),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Failed to fetch shipment fee', fee: 0, vat_rate: VAT_SHIPPING_RATE * 100 })
  }
})

// ===== Create/Update Customer =====
app.post('/api/customers', async (req: Request, res: Response) => {
  const {
    name,
    email,
    phone,
    billing_street,
    billing_city,
    billing_state,
    billing_zip,
    billing_country,
    shipping_street,
    shipping_city,
    shipping_state,
    shipping_zip,
    shipping_country
  } = req.body

  if (!name || !email) {
    return res.status(400).json({ message: 'Name and email are required' })
  }

  try {
    const [existing] = await db.query<RowDataPacket[]>(
      'SELECT id FROM customers WHERE email = ?',
      [email]
    )

    if (existing.length > 0) {
      // Update existing customer
      await db.query(
        `UPDATE customers SET
          name = ?,
          phone = ?,
          billing_street = ?,
          billing_city = ?,
          billing_state = ?,
          billing_zip = ?,
          billing_country = ?,
          shipping_street = ?,
          shipping_city = ?,
          shipping_state = ?,
          shipping_zip = ?,
          shipping_country = ?
        WHERE id = ?`,
        [
          name,
          phone || null,
          billing_street || null,
          billing_city || null,
          billing_state || null,
          billing_zip || null,
          billing_country || null,
          shipping_street || null,
          shipping_city || null,
          shipping_state || null,
          shipping_zip || null,
          shipping_country || null,
          existing[0].id
        ]
      )

      return res.status(200).json({
        id: existing[0].id,
        name,
        email,
        phone,
        billing_street,
        billing_city,
        billing_state,
        billing_zip,
        billing_country,
        shipping_street,
        shipping_city,
        shipping_state,
        shipping_zip,
        shipping_country,
      })
    }

    // Create new customer
    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO customers (
        name, email, phone,
        billing_street, billing_city, billing_state, billing_zip, billing_country,
        shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        email,
        phone || null,
        billing_street || null,
        billing_city || null,
        billing_state || null,
        billing_zip || null,
        billing_country || null,
        shipping_street || null,
        shipping_city || null,
        shipping_state || null,
        shipping_zip || null,
        shipping_country || null
      ]
    )

    res.status(201).json({
      id: result.insertId,
      name,
      email,
      phone,
      billing_street,
      billing_city,
      billing_state,
      billing_zip,
      billing_country,
      shipping_street,
      shipping_city,
      shipping_state,
      shipping_zip,
      shipping_country,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Create Order from Customer (with Payment Processing) =====
app.post('/api/customer/orders', async (req: Request, res: Response) => {
  // Print all received parameters for debugging
  console.log('Order received:', JSON.stringify(req.body, null, 2))

  const {
    customer_id,
    products, // Array of { product_id, quantity, variant_id? }
    discount_amount,
    payment_method_id, // Stripe payment method ID
  } = req.body

  if (!customer_id || !products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: 'Customer ID and products are required' })
  }

  if (!payment_method_id) {
    return res.status(400).json({ message: 'Payment method is required' })
  }

  try {
    await ensureSalesPaymentIntentIdColumn()

    // 1. Resolve selected variants and calculate totals
    const ordersBySeller: { [key: number]: any[] } = {}
    const commissionSettings = await getCommissionSettings()
    let grandTotal = 0
    let totalTax = 0

    for (const orderProduct of products) {
      const productId = Number(orderProduct?.product_id)
      const quantity = Number(orderProduct?.quantity)
      const variantIdRaw = orderProduct?.variant_id
      const variantId = variantIdRaw == null ? null : Number(variantIdRaw)

      if (!Number.isFinite(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ message: 'Invalid product or quantity in order' })
      }

      let variant: RowDataPacket | null = null

      if (variantId != null && Number.isFinite(variantId)) {
        const [selectedVariantRows] = await db.query<RowDataPacket[]>(
          `SELECT
             p.id AS product_id,
             p.seller_id,
             p.name,
             p.tax_class,
             pv.id AS variant_id,
             pv.variant_name,
             pv.variant_value,
             pv.sku,
             pv.price,
             COALESCE(pv.discount_price, pv.price) AS effective_price,
             pv.stock_quantity,
             pv.type,
             pv.file_url
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.product_id = ? AND pv.id = ?
           LIMIT 1`,
          [productId, variantId],
        )
        variant = selectedVariantRows[0] || null
      } else {
        const [defaultVariantRows] = await db.query<RowDataPacket[]>(
          `SELECT
             p.id AS product_id,
             p.seller_id,
             p.name,
             p.tax_class,
             pv.id AS variant_id,
             pv.variant_name,
             pv.variant_value,
             pv.sku,
             pv.price,
             COALESCE(pv.discount_price, pv.price) AS effective_price,
             pv.stock_quantity,
             pv.type,
             pv.file_url
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.product_id = ?
           ORDER BY pv.id ASC
           LIMIT 1`,
          [productId],
        )
        variant = defaultVariantRows[0] || null
      }

      if (!variant) {
        return res.status(400).json({ message: `Product or selected variant not found (product_id: ${productId})` })
      }

      // Check stock (only for physical products)
      if (variant.type === 'physical' && Number(variant.stock_quantity || 0) < quantity) {
        return res.status(400).json({
          message: `Insufficient stock for product variant: ${variant.name} (${variant.variant_name}: ${variant.variant_value}). Available: ${variant.stock_quantity}`
        })
      }

      const unitPrice = Number(variant.effective_price || variant.price || 0)
      const totalPrice = unitPrice * quantity

      const taxRate = parseTaxRateFromDbValue(variant.tax_class)
      const taxAmount = calculateTaxOnItem(totalPrice, taxRate)
      //const commissionAmount = calculateCommissionAmount(totalPrice, commissionSettings.rate, commissionSettings.fixed)

      grandTotal += totalPrice
      totalTax += taxAmount

      // Group by seller
      if (!ordersBySeller[variant.seller_id]) {
        ordersBySeller[variant.seller_id] = []
      }

      ordersBySeller[variant.seller_id].push({
        product_id: variant.product_id,
        product_name: variant.name,
        seller_id: variant.seller_id,
        variant_id: variant.variant_id,
        variant_name: variant.variant_name,
        variant_value: variant.variant_value,
        variant_sku: variant.sku,
        type: variant.type,
        file_url: variant.file_url || null,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        tax_amount: taxAmount,
        commission_amount: 0,
      })
    }

    // Resolve shipment from seller shipment policies (fee in DB is without VAT)
    const [customerRows] = await db.query<RowDataPacket[]>(
      `SELECT
         name,
         email,
         shipping_street,
         shipping_city,
         shipping_state,
         shipping_zip,
         shipping_country
       FROM customers
       WHERE id = ?
       LIMIT 1`,
      [customer_id],
    )

    if (customerRows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' })
    }

    const shippingCountry = String(customerRows[0].shipping_country || '').trim()
    const hasPhysicalItems = Object.values(ordersBySeller).some((items: any) =>
      (items as any[]).some((item) => item.type === 'physical'),
    )
    const sellersWithPhysicalItems = new Set<number>(
      Object.entries(ordersBySeller)
        .filter(([, items]) => (items as any[]).some((item) => item.type === 'physical'))
        .map(([sellerId]) => Number(sellerId))
        .filter((sellerId) => Number.isFinite(sellerId) && sellerId > 0),
    )

    if (hasPhysicalItems && !shippingCountry) {
      return res.status(400).json({ message: 'Customer shipping country is required for shipment fee calculation' })
    }

    const hasVatRateColumn = await hasShipmentPolicyVatRateColumn()
    const sellerShippingPolicyMap = new Map<number, { feeNoVat: number; vatAmount: number }>()
    let shippingFeeNoVat = 0
    let shippingFeeVat = 0

    for (const sellerIdRaw of Object.keys(ordersBySeller)) {
      const sellerId = Number(sellerIdRaw)

      let feeNoVat = 0
      let vatRateDecimal = VAT_SHIPPING_RATE

      if (shippingCountry && sellersWithPhysicalItems.has(sellerId)) {
        const [policyRows] = await db.query<RowDataPacket[]>(
          `SELECT fee${hasVatRateColumn ? ', vat_rate' : ''}
           FROM shipment_policies
           WHERE seller_id = ? AND country = ?
           LIMIT 1`,
          [sellerId, shippingCountry],
        )

        if (policyRows.length > 0) {
          feeNoVat = Number(policyRows[0].fee || 0)
          if (hasVatRateColumn) {
            const rawVatRate = Number(policyRows[0].vat_rate)
            vatRateDecimal = Number.isFinite(rawVatRate) ? rawVatRate / 100 : VAT_SHIPPING_RATE
          }
        }
      }

      const vatAmount = calculateTaxOnShipment(feeNoVat, vatRateDecimal)
      sellerShippingPolicyMap.set(sellerId, { feeNoVat, vatAmount })
      shippingFeeNoVat += feeNoVat
      shippingFeeVat += vatAmount
    }

    const shippingFeeWithVat = shippingFeeNoVat + shippingFeeVat

    const orderProductsForCommission = Object.values(ordersBySeller).reduce<OrderProduct[]>(
      (acc, items) => {
        for (const item of items as any[]) {
          acc.push({
            seller_id: Number(item.seller_id),
            total_price: Number(item.total_price || 0),
            tax_amount: Number(item.tax_amount || 0),
            quantity: Number(item.quantity || 0),
            product_id: Number(item.product_id || 0),
          })
        }
        return acc
      },
      [],
    )

    const commissionBreakdown = calculateCommissionBreakdown(
      orderProductsForCommission,
      sellerShippingPolicyMap,
      commissionSettings.percent,
      commissionSettings.fixed,
    )

    const sellerCommissionMap = new Map(
      commissionBreakdown.sellerBreakdown.map((item) => [item.seller_id, item]),
    )

    // Charge customer shipping fee WITH VAT
    const finalTotal = commissionBreakdown.totalGrandAmount
    const useTestReceiver = config.EMAIL.useTestReceiver
    const testReceiverEmail = config.EMAIL.testReceiver

    // 2. Process Payment via Stripe
    let paymentIntent
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(finalTotal * 100), // Convert to cents
        currency: 'SEK',
        payment_method: payment_method_id,
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      })

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({
          message: 'Payment failed',
          status: paymentIntent.status
        })
      }
    } catch (paymentError: any) {
      console.error('Payment error:', paymentError)
      // Return generic error without exposing provider details
      return res.status(400).json({
        message: 'Payment processing failed. Please try again or contact support.'
      })
    }

    // 3. Payment Successful - Create Orders for each seller
    const createdOrders = []
    const groupOrderId = generateGroupOrderId()
    const allDigitalDownloadTokens: Array<{ product_name: string; token: string }> = []
    const digitalOnlySaleIds: number[] = []

    for (const [sellerId, items] of Object.entries(ordersBySeller)) {
      const sellerTotal = items.reduce((sum: number, item: any) => sum + Number(item.total_price || 0), 0)
      const sellerTax = items.reduce((sum: number, item: any) => sum + Number(item.tax_amount || 0), 0)
      const sellerHasPhysicalItems = (items as any[]).some((item) => item.type === 'physical')
      const policyShipping = sellerShippingPolicyMap.get(Number(sellerId)) || { feeNoVat: 0, vatAmount: 0 }
      const sellerShippingNoVat = policyShipping.feeNoVat
      const sellerShippingVat = policyShipping.vatAmount
      const sellerShippingWithVat = sellerShippingNoVat + sellerShippingVat
      //const sellerDiscount = Number(discount_amount || 0) / Object.keys(ordersBySeller).length // Split discount

      // Commission is on (total + tax + shipment + shipping VAT)
      const sellerGrandTotal = sellerTotal + sellerTax + sellerShippingWithVat
      const sellerCommissionBreakdown = sellerCommissionMap.get(Number(sellerId))
      const sellerCommission = Number(sellerCommissionBreakdown?.commissionAmount || 0)

      const orderIdUnique = generateSellerOrderId(groupOrderId, sellerId)

      // Create order in sales table
      const [orderResult] = await db.query<ResultSetHeader>(
        `INSERT INTO sales (
          order_id, group_order_id, customer_id, seller_id, order_status,
          tax_amount, grand_total, commission_amount, payout_status, payment_intent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderIdUnique,
          groupOrderId,
          customer_id,
          sellerId,
          'pending',
          sellerTax,
          sellerGrandTotal,
          sellerCommission,
          'unpaid',
          paymentIntent.id,
        ]
      )

      const saleId = orderResult.insertId
      if (!sellerHasPhysicalItems) {
        digitalOnlySaleIds.push(saleId)
      }

      // Create line items for each product
      for (const item of items as any[]) {
        const lineItemProductName = item.variant_name && item.variant_value
          ? `${item.product_name} (${item.variant_name}: ${item.variant_value})`
          : item.product_name

        await db.query<ResultSetHeader>(
          `INSERT INTO sale_items (
            sale_id, product_type, product_id, product_name, quantity, unit_price, tax_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            'item',
            item.product_id,
            lineItemProductName,
            item.quantity,
            item.unit_price,
            item.tax_amount,
          ]
        )

        // Update selected variant stock (only for physical products)
        if (item.type === 'physical') {
          const [updateResult] = await db.query<ResultSetHeader>(
            `UPDATE product_variants
             SET stock_quantity = stock_quantity - ?
             WHERE id = ? AND product_id = ? AND type = 'physical' AND stock_quantity >= ?`,
            [item.quantity, item.variant_id, item.product_id, item.quantity],
          )

          if (!updateResult.affectedRows) {
            return res.status(400).json({ message: `Insufficient stock for selected variant of product: ${item.product_name}` })
          }
        }
      }

      // Create shipment entry if shipping fee exists
      if (sellerShippingNoVat > 0) {
        await db.query<ResultSetHeader>(
          `INSERT INTO sale_items (
            sale_id, product_type, product_id, product_name, quantity, unit_price, tax_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId,
            'shipment',
            null,
            'Shipment',
            1,
            sellerShippingNoVat,
            sellerShippingVat,
          ]
        )
      }

      // Create download tokens for digital items in this order
      await ensureDigitalDownloadTokensTable()
      for (const item of items as any[]) {
        if (item.type === 'digital' && item.file_url) {
          const downloadToken = crypto.randomUUID()
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
          await db.query<ResultSetHeader>(
            `INSERT INTO digital_download_tokens
              (token, sale_id, product_id, variant_id, product_name, file_url, customer_email, max_downloads, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 3, ?)`,
            [
              downloadToken,
              saleId,
              item.product_id,
              item.variant_id,
              item.product_name,
              item.file_url,
              String(customerRows[0].email || ''),
              expiresAt,
            ],
          )
          allDigitalDownloadTokens.push({ product_name: String(item.product_name || ''), token: downloadToken })
        }
      }

      createdOrders.push({
        order_id: orderIdUnique,
        sale_id: saleId,
        seller_id: Number(sellerId),
      })
    }

    // Send single consolidated invoice for all orders
    try {
      const sellerIdsInOrder = Object.keys(ordersBySeller)
        .map((sellerId) => Number(sellerId))
        .filter((sellerId) => Number.isFinite(sellerId) && sellerId > 0)

      const privateSellerMap = new Map<number, boolean>()
      if (sellerIdsInOrder.length > 0) {
        const [profileRows] = await db.query<RowDataPacket[]>(
          `SELECT p.user_id, p.profile_type
           FROM profiles p
           INNER JOIN (
             SELECT user_id, MAX(id) AS latest_id
             FROM profiles
             WHERE user_id IN (?)
             GROUP BY user_id
           ) latest ON latest.latest_id = p.id`,
          [sellerIdsInOrder],
        )

        for (const profile of profileRows) {
          privateSellerMap.set(
            Number(profile.user_id),
            String(profile.profile_type || '').toLowerCase() === 'private',
          )
        }
      }

      const allInvoiceItems: Array<{
        product_name: string
        quantity: number | null
        unit_price: number
        tax_amount: number
        total_price: number
        seller_key?: string
        is_private_seller?: boolean
        product_type?: 'item' | 'shipment'
      }> = []

      // Collect all items from all sellers
      for (const [sellerId, items] of Object.entries(ordersBySeller)) {
        for (const item of items as any[]) {
          allInvoiceItems.push({
            product_name: String(item.product_name || ''),
            quantity: Number(item.quantity || 0),
            unit_price: Number(item.unit_price || 0),
            tax_amount: Number(item.tax_amount || 0),
            total_price: Number(item.total_price || 0),
            seller_key: String(sellerId),
            is_private_seller: Boolean(privateSellerMap.get(Number(sellerId))),
            product_type: 'item',
          })
        }

        // Add shipment for this seller
        const numericSellerId = Number(sellerId)
        const policyShipping = sellerShippingPolicyMap.get(numericSellerId) || { feeNoVat: 0, vatAmount: 0 }
        if (sellersWithPhysicalItems.has(numericSellerId) && policyShipping.feeNoVat > 0) {
          allInvoiceItems.push({
            product_name: 'Shipment',
            quantity: null,
            unit_price: Number(policyShipping.feeNoVat || 0),
            tax_amount: Number(policyShipping.vatAmount || 0),
            total_price: Number(policyShipping.feeNoVat || 0),
            seller_key: String(sellerId),
            is_private_seller: false,
            product_type: 'shipment',
          })
        }
      }
      const orderIdsSummary = `#${groupOrderId}`

      const shippingParts = [
        customerRows[0].shipping_street,
        customerRows[0].shipping_city,
        customerRows[0].shipping_state,
        customerRows[0].shipping_zip,
        customerRows[0].shipping_country,
      ]
        .filter((part) => Boolean(part && String(part).trim()))
        .join(', ')

      const html = createInvoiceEmailHtml({
        company: {
          company_logo_url: String(config.EMAIL.companyLogoUrl || '').trim(),
          company_name: String(config.EMAIL.companyName || 'Smart Embedded System').trim(),
          company_email: String(config.EMAIL.address || config.SMTP.user || '').trim(),
          company_address: String(config.EMAIL.companyAddress || '').trim(),
          organization_number: String(config.COMPANY_ORGANIZATION_NUMBER || '').trim(),
        },
        customer_name: String(customerRows[0].name || 'Customer'),
        order_id: orderIdsSummary,
        order_date: new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
        customer_email: String(customerRows[0].email || ''),
        shipping_address: shippingParts || 'N/A',
        seller_email: 'Multiple Sellers',
        grand_total: finalTotal,
        tax_amount: totalTax + shippingFeeVat,
        commission_amount: commissionBreakdown.totalCommission,
        net_amount:
          finalTotal -
          (totalTax + shippingFeeVat) -
          commissionBreakdown.totalCommission,
        items: allInvoiceItems,
      })

      const receiverEmail = useTestReceiver ? testReceiverEmail : String(customerRows[0].email || '')
      if (receiverEmail) {
        const subject = `Invoice for Orders ${orderIdsSummary}`
        await sendEmail(receiverEmail, subject, html)
      } else {
        console.warn('Skipped invoice email: missing receiver email')
      }
    } catch (invoiceError) {
      console.error('Invoice email failed:', invoiceError)
    }

    // Send digital product download email if any digital items were ordered
    try {
      if (allDigitalDownloadTokens.length > 0) {
        const backendBaseUrl = getServerBaseUrl(req)
        const digitalEmailHtml = createDigitalProductEmailHtml({
          company: {
            company_logo_url: String(config.EMAIL.companyLogoUrl || '').trim(),
            company_name: String(config.EMAIL.companyName || 'Smart Embedded System').trim(),
            company_email: String(config.EMAIL.address || config.SMTP.user || '').trim(),
            company_address: String(config.EMAIL.companyAddress || '').trim(),
            organization_number: String(config.COMPANY_ORGANIZATION_NUMBER || '').trim(),
          },
          customer_name: String(customerRows[0].name || 'Customer'),
          order_id: `#${groupOrderId}`,
          order_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
          items: allDigitalDownloadTokens.map((t) => ({
            product_name: t.product_name,
            download_url: `${backendBaseUrl}/api/public/download/${t.token}`,
          })),
        })
        const digitalReceiverEmail = useTestReceiver
          ? testReceiverEmail
          : String(customerRows[0].email || '')
        if (digitalReceiverEmail) {
          await sendEmail(
            digitalReceiverEmail,
            `Your digital products — Order #${groupOrderId}`,
            digitalEmailHtml,
          )

          if (digitalOnlySaleIds.length > 0) {
            await db.query<ResultSetHeader>(
              `UPDATE sales SET order_status = 'delivered' WHERE id IN (${digitalOnlySaleIds.map(() => '?').join(',')})`,
              digitalOnlySaleIds,
            )
          }
        }
      }
    } catch (digitalEmailError) {
      console.error('Digital product email failed:', digitalEmailError)
    }

    const shipmentSummary = Array.from(sellerShippingPolicyMap.entries())
      .filter(([sellerId, policy]) => sellersWithPhysicalItems.has(Number(sellerId)) && Number(policy.feeNoVat || 0) > 0)
      .map(([sellerId, policy]) => {
        const feeNoVat = Number(policy.feeNoVat || 0)
        const vatAmount = Number(policy.vatAmount || 0)
        return {
          seller_id: Number(sellerId),
          shipment_name: 'Shipment',
          fee_no_vat: feeNoVat,
          vat_amount: vatAmount,
          fee_incl_vat: feeNoVat + vatAmount,
        }
      })

    res.status(201).json({
      message: 'Order placed successfully',
      payment_intent_id: paymentIntent.id,
      payment_status: 'paid',
      group_order_id: groupOrderId,
      order_ids: createdOrders.map(o => o.order_id),
      total_amount: finalTotal,
      total_commission: commissionBreakdown.totalCommission,
      commission_summary: commissionBreakdown,
      shipment_summary: shipmentSummary,
    })

    emitToAdmin('order:created', {
      group_order_id: groupOrderId,
      order_ids: createdOrders.map((order) => order.order_id),
      payment_intent_id: paymentIntent.id,
      total_amount: finalTotal,
    })

    for (const createdOrder of createdOrders) {
      emitToSeller(createdOrder.seller_id, 'order:created', {
        sale_id: createdOrder.sale_id,
        order_id: createdOrder.order_id,
        group_order_id: groupOrderId,
        total_amount: finalTotal,
      })
    }
  } catch (err) {
    console.error('Order creation error:', err)
    res.status(500).json({ message: 'Failed to process order' })
  }
})

app.get('/api/public/download/:token', async (req: Request, res: Response) => {
  try {
    await ensureDigitalDownloadTokensTable()
    const token = String(req.params.token || '').trim()

    if (!token) {
      res.status(400).json({ message: 'Invalid download token.' })
      return
    }

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT * FROM digital_download_tokens WHERE token = ? LIMIT 1`,
      [token],
    )

    if (!rows.length) {
      res.status(404).json({ message: 'Download link not found.' })
      return
    }

    const record = rows[0]

    if (new Date(record.expires_at) < new Date()) {
      res.status(410).json({ message: 'This download link has expired.' })
      return
    }

    if (Number(record.download_count) >= Number(record.max_downloads)) {
      res.status(403).json({ message: 'Maximum download limit reached for this link.' })
      return
    }

    await db.query(
      `UPDATE digital_download_tokens SET download_count = download_count + 1 WHERE token = ?`,
      [token],
    )

    const relativePath = String(record.file_url || '').replace(/^\/uploads\//, '')
    const filePath = path.join(__dirname, 'uploads', relativePath)

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ message: 'File not found on server.' })
      return
    }

    res.download(filePath)
  } catch (err) {
    console.error('Download endpoint error:', err)
    res.status(500).json({ message: 'Failed to process download request.' })
  }
})

app.post('/api/public/shipment-estimate', async (req: Request, res: Response) => {
  try {
    const sellerIdsRaw = Array.isArray(req.body?.seller_ids) ? req.body.seller_ids : []
    const country = String(req.body?.country || '').trim()

    const sellerIds: number[] = Array.from(
      new Set(
        sellerIdsRaw
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isFinite(value) && value > 0),
      ),
    )

    if (!sellerIds.length || !country) {
      return res.json({
        shipment_summary: [],
        shipment_fee_no_vat: 0,
        shipment_vat: 0,
        shipment_fee_incl_vat: 0,
      })
    }

    const hasVatRateColumn = await hasShipmentPolicyVatRateColumn()
    const shipmentSummary: Array<{
      seller_id: number
      shipment_name: string
      fee_no_vat: number
      vat_amount: number
      fee_incl_vat: number
    }> = []

    let shipmentFeeNoVat = 0
    let shipmentVat = 0

    for (const sellerId of sellerIds) {
      const [policyRows] = await db.query<RowDataPacket[]>(
        `SELECT fee${hasVatRateColumn ? ', vat_rate' : ''}
         FROM shipment_policies
         WHERE seller_id = ? AND country = ?
         LIMIT 1`,
        [sellerId, country],
      )

      if (!policyRows.length) continue

      const feeNoVat = Number(policyRows[0].fee || 0)
      let vatRateDecimal = VAT_SHIPPING_RATE

      if (hasVatRateColumn) {
        const rawVatRate = Number(policyRows[0].vat_rate)
        vatRateDecimal = Number.isFinite(rawVatRate) ? rawVatRate / 100 : VAT_SHIPPING_RATE
      }

      const vatAmount = calculateTaxOnShipment(feeNoVat, vatRateDecimal)

      if (feeNoVat <= 0) continue

      shipmentSummary.push({
        seller_id: sellerId,
        shipment_name: 'Shipment',
        fee_no_vat: feeNoVat,
        vat_amount: vatAmount,
        fee_incl_vat: feeNoVat + vatAmount,
      })

      shipmentFeeNoVat += feeNoVat
      shipmentVat += vatAmount
    }

    return res.json({
      shipment_summary: shipmentSummary,
      shipment_fee_no_vat: shipmentFeeNoVat,
      shipment_vat: shipmentVat,
      shipment_fee_incl_vat: shipmentFeeNoVat + shipmentVat,
    })
  } catch (error) {
    console.error('Shipment estimate error:', error)
    return res.status(500).json({ message: 'Failed to estimate shipment fee' })
  }
})

// ===== Create Order (Manual - for Seller Use) =====
app.post('/api/orders', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const {
    order_id,
    customer_id,
    total_amount,
    tax_amount,
    shipping_fee,
  } = req.body

  if (!order_id || !customer_id || !total_amount) {
    return res.status(400).json({ message: 'Required fields are missing' })
  }

  // Calculate grand total including shipment
  const grand_total = Number(total_amount) + Number(tax_amount || 0) + Number(shipping_fee || 0)

  try {
    const commissionSettings = await getCommissionSettings()
    const commission_amount = calculateCommissionAmount(
      grand_total,
      commissionSettings.rate,
      commissionSettings.fixed,
    )

    const [result] = await db.query<ResultSetHeader>(
      `INSERT INTO sales (
        order_id, customer_id, seller_id, order_status,
        tax_amount, grand_total, commission_amount, payout_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        order_id,
        customer_id,
        auth.id,
        'pending',
        tax_amount || 0,
        grand_total,
        commission_amount,
        'unpaid',
      ]
    )

    res.status(201).json({
      id: result.insertId,
      order_id,
      message: 'Order created successfully',
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Dashboard Metrics =====
app.get('/api/dashboard/metrics', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const sellerId = auth.id

    // Get total products count
    const [productCount] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) as count FROM products WHERE seller_id = ?',
      [sellerId]
    )

    // Get total orders count and revenue (paid payouts)
    const [orderStats] = await db.query<RowDataPacket[]>(
      `SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(grand_total), 0) as total_revenue
       FROM sales
      WHERE seller_id = ? AND payout_status = 'paid'`,
      [sellerId]
    )

    // Get unique customers count
    const [customerCount] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT customer_id) as count
       FROM sales
      WHERE seller_id = ? AND payout_status = 'paid'`,
      [sellerId]
    )

    // Get monthly sales data (last 12 months)
    const [monthlySales] = await db.query<RowDataPacket[]>(
      `SELECT
        DATE_FORMAT(order_date, '%Y-%m') as month,
        COALESCE(SUM(grand_total), 0) as revenue,
        COUNT(*) as order_count
       FROM sales
      WHERE seller_id = ? AND payout_status = 'paid'
       AND order_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(order_date, '%Y-%m')
       ORDER BY month ASC`,
      [sellerId]
    )

    // Get current month revenue
    const [currentMonthRevenue] = await db.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(grand_total), 0) as revenue
       FROM sales
      WHERE seller_id = ? AND payout_status = 'paid'
       AND YEAR(order_date) = YEAR(NOW())
       AND MONTH(order_date) = MONTH(NOW())`,
      [sellerId]
    )

    // Get previous month revenue for comparison
    const [previousMonthRevenue] = await db.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(grand_total), 0) as revenue
       FROM sales
      WHERE seller_id = ? AND payout_status = 'paid'
       AND YEAR(order_date) = YEAR(DATE_SUB(NOW(), INTERVAL 1 MONTH))
       AND MONTH(order_date) = MONTH(DATE_SUB(NOW(), INTERVAL 1 MONTH))`,
      [sellerId]
    )

    // Calculate percentage changes
    const currentRevenue = orderStats[0].total_revenue || 0
    const currentMonthRev = currentMonthRevenue[0].revenue || 0
    const previousMonthRev = previousMonthRevenue[0].revenue || 0

    const revenueChange = previousMonthRev > 0
      ? ((currentMonthRev - previousMonthRev) / previousMonthRev) * 100
      : 0

    res.status(200).json({
      products: {
        count: productCount[0].count || 0
      },
      orders: {
        count: orderStats[0].order_count || 0,
        total_revenue: currentRevenue
      },
      customers: {
        count: customerCount[0].count || 0
      },
      monthly: {
        current_revenue: currentMonthRev,
        previous_revenue: previousMonthRev,
        revenue_change_percent: Math.round(revenueChange * 100) / 100
      },
      monthly_sales: monthlySales.map((row: any) => ({
        month: row.month,
        revenue: row.revenue,
        order_count: row.order_count
      }))
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Customer Demographics by Country =====
app.get('/api/dashboard/customer-demographics', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const sellerId = auth.id

    // Get customers grouped by country
    const [countryData] = await db.query<RowDataPacket[]>(
      `SELECT
        COALESCE(c.shipping_country, 'Unknown') as country,
        COUNT(DISTINCT c.id) as customer_count
       FROM sales s
       INNER JOIN customers c ON s.customer_id = c.id
      WHERE s.seller_id = ? AND s.payout_status = 'paid'
       GROUP BY c.shipping_country
       ORDER BY customer_count DESC
       LIMIT 10`,
      [sellerId]
    )

    // Get customers grouped by city and country
    const [cityData] = await db.query<RowDataPacket[]>(
      `SELECT
        COALESCE(c.shipping_city, 'Unknown') as city,
        COALESCE(c.shipping_country, 'Unknown') as country,
        COUNT(DISTINCT c.id) as customer_count
       FROM sales s
       INNER JOIN customers c ON s.customer_id = c.id
      WHERE s.seller_id = ? AND s.payout_status = 'paid'
       GROUP BY c.shipping_city, c.shipping_country
       ORDER BY customer_count DESC
       LIMIT 20`,
      [sellerId]
    )

    // Calculate total customers
    const totalCustomers = countryData.reduce((sum: number, row: any) => sum + row.customer_count, 0)

    // Add percentages
    const countriesWithPercentage = countryData.map((row: any) => ({
      country: row.country,
      customer_count: row.customer_count,
      percentage: totalCustomers > 0 ? Math.round((row.customer_count / totalCustomers) * 100) : 0
    }))

    res.status(200).json({
      total_customers: totalCustomers,
      by_country: countriesWithPercentage,
      by_city: cityData.map((row: any) => ({
        city: row.city,
        country: row.country,
        customer_count: row.customer_count
      }))
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Statistics Chart Data (Monthly, Quarterly, Annually) =====
app.get('/api/dashboard/statistics', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const sellerId = auth.id
        const monthLabelFromParts = (yearValue: unknown, monthValue: unknown): string => {
          const year = Number(yearValue)
          const month = Number(monthValue)
          if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return ''
          const date = new Date(Date.UTC(year, month - 1, 1))
          return date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
        }

    const [orderDateColumnExists, payoutStatusColumnExists] = await Promise.all([
      hasSalesOrderDateColumn(),
      hasSalesPayoutStatusColumn(),
    ])
    const dateColumn = orderDateColumnExists ? 'order_date' : 'created_at'
    const paidFilter = payoutStatusColumnExists ? " AND payout_status = 'paid'" : ''

    // Get monthly sales and revenue data (last 12 months)
    const [monthlyData] = await db.query<RowDataPacket[]>(
      `SELECT
        YEAR(${dateColumn}) as year_num,
        MONTH(${dateColumn}) as month_num,
        COUNT(*) as sales_count,
        COALESCE(SUM(grand_total), 0) as revenue
       FROM sales
      WHERE seller_id = ?${paidFilter}
       AND ${dateColumn} >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY YEAR(${dateColumn}), MONTH(${dateColumn})
       ORDER BY YEAR(${dateColumn}) ASC, MONTH(${dateColumn}) ASC`,
      [sellerId]
    )

    // Get quarterly sales and revenue data (last 4 quarters)
    const [quarterlyData] = await db.query<RowDataPacket[]>(
      `SELECT
        YEAR(${dateColumn}) as year_num,
        QUARTER(${dateColumn}) as quarter_num,
        COUNT(*) as sales_count,
        COALESCE(SUM(grand_total), 0) as revenue
       FROM sales
      WHERE seller_id = ?${paidFilter}
       AND ${dateColumn} >= DATE_SUB(NOW(), INTERVAL 1 YEAR)
       GROUP BY YEAR(${dateColumn}), QUARTER(${dateColumn})
       ORDER BY YEAR(${dateColumn}) ASC, QUARTER(${dateColumn}) ASC`,
      [sellerId]
    )

    // Get annual sales and revenue data (last 5 years)
    const [annualData] = await db.query<RowDataPacket[]>(
      `SELECT
        YEAR(${dateColumn}) as year,
        COUNT(*) as sales_count,
        COALESCE(SUM(grand_total), 0) as revenue
       FROM sales
      WHERE seller_id = ?${paidFilter}
       AND ${dateColumn} >= DATE_SUB(NOW(), INTERVAL 5 YEAR)
       GROUP BY YEAR(${dateColumn})
       ORDER BY YEAR(${dateColumn})`,
      [sellerId]
    )

    res.status(200).json({
      monthly: {
        labels: monthlyData.map((row: any) => monthLabelFromParts(row.year_num, row.month_num)),
        sales: monthlyData.map((row: any) => row.sales_count),
        revenue: monthlyData.map((row: any) => Number(row.revenue) || 0)
      },
      quarterly: {
        labels: quarterlyData.map((row: any) => `${row.year_num}-Q${row.quarter_num}`),
        sales: quarterlyData.map((row: any) => row.sales_count),
        revenue: quarterlyData.map((row: any) => Number(row.revenue) || 0)
      },
      annual: {
        labels: annualData.map((row: any) => row.year.toString()),
        sales: annualData.map((row: any) => row.sales_count),
        revenue: annualData.map((row: any) => Number(row.revenue) || 0)
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Payments and Earnings Data =====
app.get('/api/dashboard/payments', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const sellerId = auth.id
    const { month, year } = req.query

    // Current month/year
    const currentDate = new Date()
    const currentMonth = month ? Number(month) : currentDate.getMonth() + 1
    const currentYear = year ? Number(year) : currentDate.getFullYear()

    // Get current month sales rows for aggregate calculations
    const [currentMonthSales] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id,
        s.grand_total,
        s.commission_amount,
        COALESCE(st.total_tax, s.tax_amount, 0) as total_tax
       FROM sales s
       LEFT JOIN (
         SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
         FROM sale_items
         GROUP BY sale_id
       ) st ON st.sale_id = s.id
       WHERE s.seller_id = ?
      AND s.payout_status = 'paid'
       AND YEAR(s.order_date) = ?
       AND MONTH(s.order_date) = ?`,
      [sellerId, currentYear, currentMonth]
    )

    const currentPeriodStats = currentMonthSales.reduce(
      (acc, sale: any) => {
        const grandTotal = Number(sale.grand_total || 0)
        const commissionAmount = Number(sale.commission_amount || 0)
        const totalTax = Number(sale.total_tax || 0)
        acc.order_count += 1
        acc.total_revenue += grandTotal
        acc.total_commission += commissionAmount
        acc.total_tax += totalTax
        acc.net_earnings += calculateNetEarning(grandTotal, totalTax, commissionAmount)
        return acc
      },
      {
        order_count: 0,
        total_revenue: 0,
        total_commission: 0,
        total_tax: 0,
        net_earnings: 0,
      }
    )

    await ensureSalesPayoutColumns()

    // Get current month orders with details
    const [currentMonthOrders] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id,
        s.order_id,
        s.order_date,
        s.grand_total,
        COALESCE(st.total_tax, s.tax_amount, 0) as tax_amount,
        s.commission_amount,
        s.payout_status,
        s.payout_status as payment_status,
        s.payout_payment_date,
        s.updated_at,
        s.order_status,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.shipping_street,
        c.shipping_city,
        c.shipping_state,
        c.shipping_zip,
        c.shipping_country,
        c.billing_street,
        c.billing_city,
        c.billing_state,
        c.billing_zip,
        c.billing_country
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.seller_id = ?
      AND s.payout_status = 'paid'
      AND YEAR(s.order_date) = ?
      AND MONTH(s.order_date) = ?
      ORDER BY s.order_date DESC`,
      [sellerId, currentYear, currentMonth]
    )

    // Get monthly earnings history (last 12 months)
    const [monthlyHistory] = await db.query<RowDataPacket[]>(
      `SELECT
        YEAR(s.order_date) as year,
        MONTH(s.order_date) as month,
        DATE_FORMAT(s.order_date, '%Y-%m') as period,
        COUNT(DISTINCT s.id) as order_count,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(SUM(s.commission_amount), 0) as total_commission,
        COALESCE(SUM(COALESCE(st.total_tax, s.tax_amount, 0)), 0) as total_tax
       FROM sales s
       LEFT JOIN (
         SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
         FROM sale_items
         GROUP BY sale_id
       ) st ON st.sale_id = s.id
       WHERE s.seller_id = ?
      AND s.payout_status = 'paid'
       AND s.order_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY YEAR(s.order_date), MONTH(s.order_date), DATE_FORMAT(s.order_date, '%Y-%m')
       ORDER BY year DESC, month DESC`,
      [sellerId]
    )

    // Get payout status summary
    const [payoutSummary] = await db.query<RowDataPacket[]>(
      `SELECT
        s.payout_status,
        COUNT(*) as count,
        COALESCE(SUM(s.grand_total), 0) as total_revenue,
        COALESCE(SUM(s.commission_amount), 0) as total_commission,
        COALESCE(SUM(COALESCE(st.total_tax, s.tax_amount, 0)), 0) as total_tax
       FROM sales s
       LEFT JOIN (
         SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
         FROM sale_items
         GROUP BY sale_id
       ) st ON st.sale_id = s.id
       WHERE s.seller_id = ?
      AND s.payout_status = 'paid'
       GROUP BY s.payout_status`,
      [sellerId]
    )

    res.status(200).json({
      current_period: {
        month: currentMonth,
        year: currentYear,
        order_count: currentPeriodStats.order_count,
        total_revenue: roundToTwo(currentPeriodStats.total_revenue),
        net_earnings: roundToTwo(currentPeriodStats.net_earnings),
        total_commission: roundToTwo(currentPeriodStats.total_commission),
        total_tax: roundToTwo(currentPeriodStats.total_tax),
      },
      orders: currentMonthOrders.map((order: any) => ({
        id: order.id,
        order_id: order.order_id,
        order_date: order.order_date,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        grand_total: parseFloat(order.grand_total),
        tax_amount: parseFloat(order.tax_amount),
        commission_amount: parseFloat(order.commission_amount),
        net_amount: calculateNetEarning(order.grand_total, order.tax_amount, order.commission_amount),
        payment_status: order.payment_status,
        payout_status: order.payout_status,
        payout_payment_date: order.payout_payment_date || order.updated_at || null,
        order_status: order.order_status,
      })),
      monthly_history: monthlyHistory.map((row: any) => ({
        year: row.year,
        month: row.month,
        period: row.period,
        order_count: row.order_count,
        total_revenue: parseFloat(row.total_revenue),
        net_earnings: calculateNetEarning(row.total_revenue, row.total_tax, row.total_commission),
        total_commission: parseFloat(row.total_commission),
      })),
      payout_summary: payoutSummary.map((row: any) => ({
        status: row.payout_status,
        count: row.count,
        amount: calculateNetEarning(row.total_revenue, row.total_tax, row.total_commission),
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Orders =====
app.get('/api/orders', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    await ensureSalesPayoutColumns()
    await ensureSalesShipmentColumns()
    const paymentDateColumnExists = await hasSalesPayoutPaymentDateColumn()
    const payoutPaymentDateSelect = paymentDateColumnExists
      ? 's.payout_payment_date'
      : 'NULL AS payout_payment_date'

    const [allItems] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id as sale_id,
        s.order_id,
        s.group_order_id,
        s.customer_id,
        s.seller_id,
        s.order_date,
        s.order_status,
        s.payout_status as payment_status,
        s.order_status as shipping_status,
        COALESCE(st.total_tax, s.tax_amount, 0) as tax_amount,
        0 as shipping_fee,
        0 as discount_amount,
        s.grand_total,
        s.commission_amount,
        s.shipment_tracking_number,
        s.shipment_label_url,
        s.shipment_label_mime_type,
        s.shipment_label_generated_at,
        s.shipment_booking_id,
        s.payout_status,
        ${payoutPaymentDateSelect},
        s.created_at,
        s.updated_at,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.shipping_street,
        c.shipping_city,
        c.shipping_state,
        c.shipping_zip,
        c.shipping_country,
        si.id as item_id,
        si.product_type,
        si.product_id,
        si.product_name,
        COALESCE(p.type, 'physical') as item_type,
        p.category as item_category,
        p.main_image_url as item_main_image_url,
        COALESCE(pv.length_cm, pv_fallback.length_cm) as item_length_cm,
        COALESCE(pv.width_cm, pv_fallback.width_cm) as item_width_cm,
        COALESCE(pv.height_cm, pv_fallback.height_cm) as item_height_cm,
        COALESCE(pv.weight_kg, pv_fallback.weight_kg) as item_weight_kg,
        si.quantity,
        si.unit_price,
        (si.unit_price * si.quantity) as total_price,
        si.tax_amount as item_tax_amount
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) as total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN sale_items si ON s.id = si.sale_id
      LEFT JOIN products p ON si.product_id = p.id
      LEFT JOIN product_variants pv ON pv.product_id = si.product_id
        AND si.product_type = 'item'
        AND si.product_name LIKE '%(%:%)%'
        AND TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(si.product_name, '(', -1), ':', 1)) = pv.variant_name
        AND TRIM(TRAILING ')' FROM SUBSTRING_INDEX(SUBSTRING_INDEX(si.product_name, ':', -1), ')', 1)) = pv.variant_value
      LEFT JOIN product_variants pv_fallback ON pv_fallback.id = (
        SELECT pv2.id
        FROM product_variants pv2
        WHERE pv2.product_id = si.product_id
        ORDER BY pv2.id ASC
        LIMIT 1
      )
      WHERE s.seller_id = ?
      ORDER BY s.order_date DESC, si.id`,
      [auth.id]
    )

    // Group items by order
    const ordersMap = new Map<number, any>()

    for (const row of allItems) {
      if (!ordersMap.has(row.sale_id)) {
        ordersMap.set(row.sale_id, {
          id: row.sale_id,
          order_id: row.order_id,
          group_order_id: row.group_order_id,
          customer_id: row.customer_id,
          seller_id: row.seller_id,
          order_date: row.order_date,
          order_status: row.order_status,
          payment_status: row.payment_status,
          shipping_status: row.shipping_status,
          tax_amount: row.tax_amount,
          shipping_fee: row.shipping_fee,
          discount_amount: row.discount_amount,
          grand_total: row.grand_total,
          commission_amount: row.commission_amount,
          shipment_tracking_number: row.shipment_tracking_number || null,
          shipment_label_url: row.shipment_label_url || null,
          shipment_label_mime_type: row.shipment_label_mime_type || null,
          shipment_label_generated_at: row.shipment_label_generated_at || null,
          shipment_booking_id: row.shipment_booking_id || null,
          payout_status: row.payout_status,
          payout_payment_date: row.payout_payment_date || (row.payout_status === 'paid' ? row.updated_at : null),
          seller_net_amount: calculateNetEarning(row.grand_total, row.tax_amount, row.commission_amount),
          created_at: row.created_at,
          updated_at: row.updated_at,
          customer_name: row.customer_name,
          customer_email: row.customer_email,
          customer_phone: row.customer_phone,
          shipping_street: row.shipping_street,
          shipping_city: row.shipping_city,
          shipping_state: row.shipping_state,
          shipping_zip: row.shipping_zip,
          shipping_country: row.shipping_country,
          items: [],
        })
      }

      const order = ordersMap.get(row.sale_id)!
      if (row.item_id) {
        order.items.push({
          id: row.item_id,
          product_type: row.product_type,
          product_id: row.product_id,
          product_name: row.product_name,
          sku: null,
          type: row.item_type || 'physical',
          category: row.item_category || null,
          main_image_url: row.item_main_image_url || null,
          length_cm: row.item_length_cm != null ? Number(row.item_length_cm) : null,
          width_cm: row.item_width_cm != null ? Number(row.item_width_cm) : null,
          height_cm: row.item_height_cm != null ? Number(row.item_height_cm) : null,
          weight_kg: row.item_weight_kg != null ? Number(row.item_weight_kg) : null,
          quantity: row.quantity,
          unit_price: row.unit_price,
          total_price: row.total_price,
          tax_amount: row.item_tax_amount,
          commission_amount: 0,
          status: 'pending',
        })
      }
    }

    res.status(200).json(Array.from(ordersMap.values()))
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Get Order by ID =====
app.get('/api/orders/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const orderId = req.params.id

  try {
    await ensureSalesShipmentColumns()
    const [orders] = await db.query<RowDataPacket[]>(
      `SELECT
        s.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.shipping_street,
        c.shipping_city,
        c.shipping_state,
        c.shipping_zip,
        c.shipping_country,
        c.billing_street,
        c.billing_city,
        c.billing_state,
        c.billing_zip,
        c.billing_country
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.id = ? AND s.seller_id = ?`,
      [orderId, auth.id]
    )

    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' })
    }

    // Get order items
    const [items] = await db.query<RowDataPacket[]>(
      `SELECT
        si.id,
        si.product_type,
        si.product_id,
        si.product_name,
        si.quantity,
        si.unit_price,
        (si.unit_price * si.quantity) as total_price,
        si.tax_amount,
        p.category,
        p.brand
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?`,
      [orderId]
    )

    res.status(200).json({
      ...orders[0],
      items,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

app.post('/api/orders/:id/send-invoice', async (req: Request, res: Response) => {
  const auth = await requireSellerOrAdmin(req, res)
  if (!auth) return

  const orderId = Number(req.params.id)
  const smtpConfigured = Boolean((config.SMTP.user || config.EMAIL.address) && config.SMTP.pass)
  const useTestReceiver = config.EMAIL.useTestReceiver
  const testReceiverEmail = config.EMAIL.testReceiver

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'Invalid order id' })
  }

  try {
    const [orderRows] = await db.query<RowDataPacket[]>(
      `SELECT
        s.id,
        s.order_id,
        s.order_date,
        s.seller_id,
        s.grand_total,
        COALESCE(st.total_tax, s.tax_amount, 0) AS tax_amount,
        s.commission_amount,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone as customer_phone,
        c.shipping_street,
        c.shipping_city,
        c.shipping_state,
        c.shipping_zip,
        c.shipping_country,
        u.email as seller_email,
        sp.profile_type as seller_profile_type
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, COALESCE(SUM(tax_amount), 0) AS total_tax
        FROM sale_items
        GROUP BY sale_id
      ) st ON st.sale_id = s.id
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.seller_id
      LEFT JOIN profiles sp ON sp.id = (
        SELECT p2.id
        FROM profiles p2
        WHERE p2.user_id = s.seller_id
        ORDER BY p2.created_at DESC, p2.id DESC
        LIMIT 1
      )
      WHERE s.id = ?
      LIMIT 1`,
      [orderId],
    )

    if (orderRows.length === 0) {
      return res.status(404).json({ message: 'Order not found' })
    }

    const order = orderRows[0]

    if (auth.role === 'seller' && Number(order.seller_id) !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to send invoice for this order' })
    }

    if (!order.customer_email) {
      return res.status(400).json({ message: 'Customer email is missing for this order' })
    }

    const [itemRows] = await db.query<RowDataPacket[]>(
      `SELECT
        product_type,
        product_name,
        quantity,
        unit_price,
        tax_amount,
        (unit_price * quantity) AS total_price
      FROM sale_items
      WHERE sale_id = ?
      ORDER BY id ASC`,
      [orderId],
    )

    const isPrivateSeller = String(order.seller_profile_type || '').toLowerCase() === 'private'

    const invoiceItems = itemRows.map((item: any) => ({
      product_type: String(item.product_type || '').toLowerCase() === 'shipment' ? 'shipment' as const : 'item' as const,
      product_name: String(item.product_name || ''),
      quantity: String(item.product_type || '').toLowerCase() === 'shipment' ? null : Number(item.quantity || 0),
      unit_price: Number(item.unit_price || 0),
      tax_amount: Number(item.tax_amount || 0),
      total_price: Number(item.total_price || 0),
      seller_key: String(order.seller_id || ''),
      is_private_seller: String(item.product_type || '').toLowerCase() === 'shipment' ? false : isPrivateSeller,
    }))

    const totalInvoiceTax = invoiceItems.reduce((sum: number, item: any) => sum + Number(item.tax_amount || 0), 0)

    const tax = Number(order.tax_amount || 0)
    const commission = Number(order.commission_amount || 0)
    const grandTotal = Number(order.grand_total || 0)
    const netAmount = calculateNetEarning(grandTotal, tax, commission)

    const shippingParts = [
      order.shipping_street,
      order.shipping_city,
      order.shipping_state,
      order.shipping_zip,
      order.shipping_country,
    ]
      .filter((part) => Boolean(part && String(part).trim()))
      .join(', ')

    const html = createInvoiceEmailHtml({
      company: {
        company_logo_url: String(config.EMAIL.companyLogoUrl || '').trim(),
        company_name: String(config.EMAIL.companyName || 'Smart Embedded System').trim(),
        company_email: String(config.EMAIL.address || config.SMTP.user || '').trim(),
        company_address: String(config.EMAIL.companyAddress || '').trim(),
        organization_number: String(config.COMPANY_ORGANIZATION_NUMBER || '').trim(),
      },
      customer_name: String(order.customer_name || 'Customer'),
      order_id: String(order.order_id || order.id),
      order_date: new Date(order.order_date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      customer_email: String(order.customer_email || ''),
      shipping_address: shippingParts || 'N/A',
      seller_email: String(order.seller_email || ''),
      grand_total: grandTotal,
      tax_amount: totalInvoiceTax,
      commission_amount: commission,
      net_amount: netAmount,
      items: invoiceItems,
    })

    const receiverEmail = useTestReceiver ? testReceiverEmail : String(order.customer_email)

    if (!receiverEmail) {
      return res.status(400).json({ message: 'Receiver email is missing' })
    }

    const subject = `Invoice for Order ${order.order_id}`
    await sendEmail(receiverEmail, subject, html)

    res.status(200).json({
      message: 'Invoice email sent successfully',
      order_id: order.order_id,
      customer_email: order.customer_email,
      receiver_email: receiverEmail,
      use_test_receiver: useTestReceiver,
      smtp_configured: smtpConfigured,
      sender_email: config.SMTP.user || config.EMAIL.address || null,
    })
  } catch (error) {
    console.error('Failed to send invoice email:', error)
    const errorMessage = error instanceof Error ? error.message : 'Failed to send invoice email'
    res.status(500).json({ message: errorMessage })
  }
})

// ===== Update Order/Shipment Status =====
app.put('/api/orders/:id', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const orderId = req.params.id
  const {
    order_status,
    payout_status,
    shipping_status,
    tracking_number,
    tracking_url,
    send_tracking_email,
    status_reason,
  } = req.body

  const shippingToOrderStatus: Record<string, string> = {
    pending: 'pending',
    label_generated: 'processing',
    in_transit: 'shipped',
    shipped: 'shipped',
    delivered: 'delivered',
    returned: 'returned',
    cancelled: 'cancelled',
    processing: 'processing',
  }

  const resolvedOrderStatus =
    order_status || (shipping_status ? shippingToOrderStatus[String(shipping_status)] : undefined)

  try {
    // Check if order exists and belongs to the user
    const [orders] = await db.query<RowDataPacket[]>(
      'SELECT id, seller_id, order_id FROM sales WHERE id = ?',
      [orderId]
    )

    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' })
    }

    if (orders[0].seller_id !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to update this order' })
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = []
    const values: any[] = []
    const paymentDateColumnExists = payout_status ? await hasSalesPayoutPaymentDateColumn() : false

    if (resolvedOrderStatus) {
      updates.push('order_status = ?')
      values.push(resolvedOrderStatus)
    }

    const statusReason = String(status_reason || '').trim()
    if (resolvedOrderStatus === 'cancelled' || resolvedOrderStatus === 'returned') {
      if (!statusReason) {
        return res.status(400).json({
          message: resolvedOrderStatus === 'returned' ? 'Return reason is required' : 'Cancellation reason is required',
        })
      }

      await ensureSalesStatusReasonColumn()
      updates.push('status_reason = ?')
      values.push(statusReason)
    }

    if (payout_status) {
      updates.push('payout_status = ?')
      values.push(payout_status)

      if (paymentDateColumnExists) {
        if (payout_status === 'paid') {
          updates.push('payout_payment_date = ?')
          values.push(toCETDateTime())
        } else if (payout_status === 'unpaid') {
          updates.push('payout_payment_date = NULL')
        }
      }
    }

    const trackingNumber = tracking_number ? String(tracking_number).trim() : null
    const trackingUrl = tracking_url ? String(tracking_url).trim() : null
    if (trackingNumber) {
      updates.push('shipment_tracking_number = ?')
      values.push(trackingNumber)
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' })
    }

    values.push(orderId)

    await db.query(
      `UPDATE sales SET ${updates.join(', ')} WHERE id = ?`,
      values
    )

    let emailSent = false
    if (resolvedOrderStatus === 'shipped' && send_tracking_email === true && trackingNumber) {
      try {
        const [orderRows] = await db.query<RowDataPacket[]>(
          `SELECT s.order_id, s.order_date,
                  c.name AS customer_name, c.email AS customer_email,
                  c.shipping_street, c.shipping_city, c.shipping_state, c.shipping_zip, c.shipping_country
           FROM sales s
           LEFT JOIN customers c ON s.customer_id = c.id
           WHERE s.id = ?
           LIMIT 1`,
          [orderId]
        )
        if (orderRows.length > 0) {
          const o = orderRows[0]
          const customerEmail = String(o.customer_email || '')
          if (customerEmail) {
            const shippingParts = [o.shipping_street, o.shipping_city, o.shipping_state, o.shipping_zip, o.shipping_country]
              .filter((p) => Boolean(p && String(p).trim()))
              .join(', ')
            const defaultTrackingBase = String(config.POSTNORD_TRACKING_BASE_URL || '').trim()
            const defaultTrackingUrl = defaultTrackingBase
              ? `${defaultTrackingBase}${encodeURIComponent(trackingNumber)}`
              : null
            const finalTrackingUrl = trackingUrl || defaultTrackingUrl || ''
            const html = createShipmentNotificationEmailHtml({
              company: {
                company_logo_url: String(config.EMAIL.companyLogoUrl || '').trim(),
                company_name: String(config.EMAIL.companyName || 'Smart Embedded System').trim(),
                company_email: String(config.EMAIL.address || config.SMTP.user || '').trim(),
                company_address: String(config.EMAIL.companyAddress || '').trim(),
                organization_number: String(config.COMPANY_ORGANIZATION_NUMBER || '').trim(),
              },
              customer_name: String(o.customer_name || 'Customer'),
              order_id: String(o.order_id || orderId),
              order_date: o.order_date ? new Date(o.order_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '',
              tracking_number: trackingNumber,
              tracking_url: finalTrackingUrl,
              shipping_address: shippingParts || 'N/A',
            })
            await sendEmail(customerEmail, `Your order has been shipped! Tracking: ${trackingNumber}`, html)
            emailSent = true
          }
        }
      } catch (emailErr) {
        console.error('[Shipment email error]', emailErr)
      }
    }

    emitToSeller(auth.id, 'order:updated', {
      sale_id: Number(orderId),
      order_id: String(orders[0].order_id || orderId),
      order_status: resolvedOrderStatus || null,
      payout_status: payout_status || null,
      shipping_status: shipping_status || null,
    })
    emitToAdmin('order:status-changed', {
      sale_id: Number(orderId),
      seller_id: auth.id,
      order_id: String(orders[0].order_id || orderId),
      order_status: resolvedOrderStatus || null,
      payout_status: payout_status || null,
    })

    res.status(200).json({
      id: orderId,
      message: 'Order updated successfully',
      email_sent: emailSent,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Shipment Cost Check =====
app.post('/api/shipment/cost', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  try {
    const payload = req.body || {}
    const portalFareEndpointPath = '/api/pricing/agreementProduct'

    // Fetch seller records from DB using exact table/column names.
    const [sellerUserRows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )
    const [sellerProfileRows] = await db.query<RowDataPacket[]>(
      `SELECT *
       FROM profiles
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [auth.id],
    )

    const db_seller_user = sellerUserRows[0]
    const db_seller_profile = sellerProfileRows[0]

    // Map sender directly from DB columns and allow payload override if provided.
    const senderAddressFromDb = {
      name: String(
        db_seller_profile?.company_name
        || `${String(db_seller_profile?.first_name || '').trim()} ${String(db_seller_profile?.last_name || '').trim()}`.trim()
        || 'Sender',
      ).trim(),
      street: String(db_seller_profile?.street || '').trim(),
      city: String(db_seller_profile?.city || '').trim(),
      postalCode: String(db_seller_profile?.zip || '').trim(),
      countryCode: normalizeCountryCode(db_seller_profile?.country || 'SE'),
      emailAddress: String(db_seller_user?.email || '').trim() || undefined,
      smsNo: String(db_seller_profile?.phone || '').trim() || undefined,
      phoneNo: String(db_seller_profile?.phone || '').trim() || undefined,
    }

    const senderAddress = payload.senderAddress && typeof payload.senderAddress === 'object'
      ? {
          ...senderAddressFromDb,
          ...payload.senderAddress,
          emailAddress: String(payload.senderAddress.emailAddress || senderAddressFromDb.emailAddress || '').trim() || undefined,
        }
      : senderAddressFromDb

    const normalizedSenderAddress = {
      ...senderAddress,
      countryCode: normalizeCountryCode(senderAddress.countryCode),
    }

    const customerIdFromPayload = Number(payload.customer_id ?? payload.customerId)
    const saleIdFromPayload = Number(payload.sale_id ?? payload.saleId)
    let customerId = Number.isFinite(customerIdFromPayload) && customerIdFromPayload > 0
      ? customerIdFromPayload
      : NaN
    let db_customer: RowDataPacket | undefined

    if ((!Number.isFinite(customerId) || customerId <= 0) && Number.isFinite(saleIdFromPayload) && saleIdFromPayload > 0) {
      const [saleRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM sales WHERE id = ? AND seller_id = ? LIMIT 1',
        [saleIdFromPayload, auth.id],
      )
      if (saleRows.length > 0) {
        const resolvedCustomerId = Number(saleRows[0].customer_id)
        if (Number.isFinite(resolvedCustomerId) && resolvedCustomerId > 0) {
          customerId = resolvedCustomerId
        }
      }
    }

    if (Number.isFinite(customerId) && customerId > 0) {
      const [customerRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customerRows.length > 0) {
        db_customer = customerRows[0]
      }
    }

    const toEmail = String(db_customer?.email || '').trim() || undefined

    const toMobilePhone = String(db_customer?.phone || '').trim() || undefined

    const dbRecipientAddress = db_customer?.shipping_street || db_customer?.shipping_city || db_customer?.shipping_zip || db_customer?.shipping_country
      ? {
          name: String(db_customer?.name || '').trim() || undefined,
          street: String(db_customer?.shipping_street || '').trim() || undefined,
          city: String(db_customer?.shipping_city || '').trim() || undefined,
          state: String(db_customer?.shipping_state || '').trim() || undefined,
          postalCode: String(db_customer?.shipping_zip || '').trim() || undefined,
          countryCode: normalizeCountryCode(db_customer?.shipping_country),
          emailAddress: toEmail,
          smsNo: toMobilePhone,
          phoneNo: toMobilePhone,
        }
      : undefined

    const rawRecipientAddress = payload.address && typeof payload.address === 'object'
      ? payload.address
      : (payload.shippingAddress && typeof payload.shippingAddress === 'object'
        ? payload.shippingAddress
        : undefined)

    const recipientAddress = rawRecipientAddress
      ? {
          ...dbRecipientAddress,
          ...rawRecipientAddress,
          countryCode: normalizeCountryCode(rawRecipientAddress.countryCode),
          emailAddress: String(rawRecipientAddress.emailAddress || toEmail || '').trim() || undefined,
          smsNo: String(rawRecipientAddress.smsNo || toMobilePhone || '').trim() || undefined,
          phoneNo: String(rawRecipientAddress.phoneNo || toMobilePhone || '').trim() || undefined,
        }
      : dbRecipientAddress

    const servicePointAddressLine1 = String(
      payload.servicePointAddressLine1
      || db_customer?.shipping_street
      || recipientAddress?.street
      || '',
    ).trim() || undefined

    const servicePointArea = String(
      payload.servicePointArea
      || db_customer?.shipping_city
      || recipientAddress?.city
      || '',
    ).trim() || undefined

    const prefs = payload.shipmentPreferences || {}
    const productType: string =
      prefs.weightClass === 'light' ? 'LETTER' : 'PARCEL'

    let shipTo: 'HOME' | 'SERVICEPOINT' = 'HOME'
    let pickup: 'NO_PICKUP' | 'BOOK_PICKUP' = 'NO_PICKUP'
    let packageType: string | undefined

    if (prefs.pickupOption === 'pickup_possible') {
      shipTo = 'HOME'
      pickup = 'BOOK_PICKUP'
      packageType = undefined
    } else if (prefs.deliverTo === 'service_point') {
      shipTo = 'SERVICEPOINT'
      pickup = 'NO_PICKUP'
      packageType = undefined
    } else {
      shipTo = 'HOME'
      pickup = 'NO_PICKUP'
      packageType = prefs.deliveryTimeOption === 'standard' ? '1DAY' : '3DAY'
    }

    const additionalInformation: boolean =
      typeof prefs.additionalInformation === 'boolean' ? prefs.additionalInformation : true

    const cost = await estimateShipmentCost({
      address: recipientAddress,
      senderAddress: normalizedSenderAddress,
      dimensions: payload.dimensions,
      weightKg: Number(payload.weightKg),
      toEmail,
      toMobilePhone,
      serviceCode: payload.serviceCode,
      additionalServiceCodes: payload.additionalServiceCodes,
      endpointPath: portalFareEndpointPath,
      shipTo,
      pickup,
      packageType,
      productType,
      additionalInformation,
      // Ensure required PostNord fare fields are always present.
      servicePointAddressLine1,
      servicePointArea,
      language: String(payload.language || 'en').trim() || 'en',
    })

    return res.status(200).json(cost)
  } catch (error) {
    console.error('Shipment cost check failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to check shipment cost'
    const statusCodeRaw = (error as { statusCode?: unknown })?.statusCode
    const details = (error as { details?: unknown })?.details
    const statusCode = typeof statusCodeRaw === 'number' && statusCodeRaw >= 400 && statusCodeRaw < 600
      ? statusCodeRaw
      : 500
    const explanationText = Array.isArray((details as any)?.compositeFault?.faults)
      ? (details as any).compositeFault.faults
          .map((fault: any) => String(fault?.explanationText || fault?.message || '').trim())
          .filter((value: string) => Boolean(value))
          .join(' | ')
      : undefined

    return res.status(statusCode).json({
      message,
      explanationText,
      details,
    })
  }
})

// ===== Shipment Label Generate + Store =====
app.post('/api/shipment/label', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const payload = req.body || {}
  const saleId = Number(payload.sale_id)

  try {
    await ensureShipmentLabelsTable()
    await ensureSalesShipmentColumns()

    let orderId: string | null = null
    let customerId: number | null = null
    if (Number.isFinite(saleId) && saleId > 0) {
      const [orderRows] = await db.query<RowDataPacket[]>(
        'SELECT id, order_id, seller_id, customer_id FROM sales WHERE id = ? LIMIT 1',
        [saleId],
      )

      if (!orderRows.length) {
        return res.status(404).json({ message: 'Order not found for provided sale_id' })
      }

      if (Number(orderRows[0].seller_id) !== auth.id) {
        return res.status(403).json({ message: 'You do not have permission for this order' })
      }

      orderId = String(orderRows[0].order_id || '') || null
      customerId = Number(orderRows[0].customer_id || 0) || null
    }

    const [sellerUserRows] = await db.query<RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )
    const [sellerProfileRows] = await db.query<RowDataPacket[]>(
      `SELECT *
       FROM profiles
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [auth.id],
    )

    const dbSellerUser = sellerUserRows[0]
    const dbSellerProfile = sellerProfileRows[0]

    const senderAddress = {
      name: String(
        dbSellerProfile?.company_name
        || `${String(dbSellerProfile?.first_name || '').trim()} ${String(dbSellerProfile?.last_name || '').trim()}`.trim()
        || 'Sender',
      ).trim(),
      companyName: String(dbSellerProfile?.company_name || '').trim() || undefined,
      street: String(dbSellerProfile?.street || '').trim(),
      postalCode: String(dbSellerProfile?.zip || '').trim(),
      city: String(dbSellerProfile?.city || '').trim(),
      countryCode: normalizeCountryCode(dbSellerProfile?.country || 'SE'),
      contactName: `${String(dbSellerProfile?.first_name || '').trim()} ${String(dbSellerProfile?.last_name || '').trim()}`.trim() || undefined,
      emailAddress: String(dbSellerUser?.email || '').trim() || undefined,
      phoneNo: String(dbSellerProfile?.phone || '').trim() || undefined,
      smsNo: String(dbSellerProfile?.phone || '').trim() || undefined,
    }

    let dbCustomer: RowDataPacket | undefined
    if (!customerId) {
      const customerIdFromPayload = Number(payload.customer_id ?? payload.customerId)
      if (Number.isFinite(customerIdFromPayload) && customerIdFromPayload > 0) {
        customerId = customerIdFromPayload
      }
    }

    if (Number.isFinite(customerId) && Number(customerId) > 0) {
      const [customerRows] = await db.query<RowDataPacket[]>(
        'SELECT * FROM customers WHERE id = ? LIMIT 1',
        [customerId],
      )
      if (customerRows.length > 0) {
        dbCustomer = customerRows[0]
      }
    }

    const recipientAddress = {
      name: String(dbCustomer?.name || payload.address?.name || 'Customer').trim(),
      companyName: String(dbCustomer?.name || payload.address?.companyName || '').trim() || undefined,
      street: String(dbCustomer?.shipping_street || payload.address?.street || '').trim(),
      postalCode: String(dbCustomer?.shipping_zip || payload.address?.postalCode || '').trim(),
      city: String(dbCustomer?.shipping_city || payload.address?.city || '').trim(),
      countryCode: normalizeCountryCode(dbCustomer?.shipping_country || payload.address?.countryCode || 'SE'),
      contactName: String(dbCustomer?.name || payload.address?.contactName || payload.address?.name || '').trim() || undefined,
      emailAddress: String(dbCustomer?.email || payload.address?.emailAddress || '').trim() || undefined,
      phoneNo: String(dbCustomer?.phone || payload.address?.phoneNo || payload.address?.phone || '').trim() || undefined,
      smsNo: String(dbCustomer?.phone || payload.address?.smsNo || payload.address?.phone || '').trim() || undefined,
    }

    const generated = await generateShipmentLabel({
      address: recipientAddress,
      senderAddress,
      dimensions: payload.dimensions,
      weightKg: Number(payload.weightKg),
      referenceNo: payload.referenceNo,
      serviceCode: payload.serviceCode,
      additionalServiceCodes: payload.additionalServiceCodes,
      paperSize: payload.paperSize,
      labelType: payload.labelType,
      endpointPath: payload.endpointPath,
      externalPayload: payload.externalPayload,
    })

    if (!generated.contentBuffer) {
      return res.status(502).json({
        message: 'Provider did not return a downloadable label binary.',
        provider_response: generated.raw,
      })
    }

    const labelsDir = path.join(__dirname, 'uploads', 'shipment_labels')
    if (!fs.existsSync(labelsDir)) {
      fs.mkdirSync(labelsDir, { recursive: true })
    }

    const ext = generated.fileName.includes('.')
      ? generated.fileName.split('.').pop()
      : generated.mimeType.includes('pdf') ? 'pdf' : generated.mimeType.startsWith('image/') ? 'png' : 'bin'

    const savedFileName = `label-${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`
    const savedFilePath = path.join(labelsDir, savedFileName)
    fs.writeFileSync(savedFilePath, generated.contentBuffer)

    const fileUrl = `/uploads/shipment_labels/${savedFileName}`
    const estimatedCostRaw = Number(payload.estimatedCost)
    const estimatedCost = Number.isFinite(estimatedCostRaw) ? roundToTwo(estimatedCostRaw) : null
    const estimatedCurrency = payload.estimatedCurrency ? String(payload.estimatedCurrency).toUpperCase() : null

    await db.query<ResultSetHeader>(
      `INSERT INTO shipment_labels (
        sale_id,
        seller_id,
        order_id,
        booking_id,
        tracking_number,
        label_format,
        mime_type,
        file_name,
        file_path,
        file_size,
        file_url,
        estimated_cost,
        estimated_currency,
        provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'postnord')`,
      [
        Number.isFinite(saleId) && saleId > 0 ? saleId : null,
        auth.id,
        orderId,
        generated.bookingId,
        generated.trackingNumber,
        generated.format,
        generated.mimeType,
        savedFileName,
        savedFilePath,
        generated.contentBuffer.length,
        fileUrl,
        estimatedCost,
        estimatedCurrency,
      ],
    )

    if (Number.isFinite(saleId) && saleId > 0) {
      const updateFields: string[] = ['order_status = ?']
      const updateValues: unknown[] = ['shipped']

      if (await hasSalesShipmentTrackingNumberColumn()) {
        updateFields.push('shipment_tracking_number = ?')
        updateValues.push(generated.trackingNumber || null)
      }
      if (await hasSalesShipmentLabelUrlColumn()) {
        updateFields.push('shipment_label_url = ?')
        updateValues.push(fileUrl)
      }
      if (await hasSalesShipmentLabelMimeTypeColumn()) {
        updateFields.push('shipment_label_mime_type = ?')
        updateValues.push(generated.mimeType || null)
      }
      if (await hasSalesShipmentLabelGeneratedAtColumn()) {
        updateFields.push('shipment_label_generated_at = ?')
        updateValues.push(toCETDateTime())
      }
      if (await hasSalesShipmentBookingIdColumn()) {
        updateFields.push('shipment_booking_id = ?')
        updateValues.push(generated.bookingId || null)
      }

      updateValues.push(saleId, auth.id)
      await db.query(
        `UPDATE sales SET ${updateFields.join(', ')} WHERE id = ? AND seller_id = ?`,
        updateValues,
      )

      await upsertShipmentLabelExpenseForSale(saleId, auth.id, estimatedCost)
    }

    return res.status(201).json({
      message: 'Shipment label generated and stored successfully',
      sale_id: Number.isFinite(saleId) && saleId > 0 ? saleId : null,
      order_id: orderId,
      booking_id: generated.bookingId,
      tracking_number: generated.trackingNumber,
      label_url: fileUrl,
      label_mime_type: generated.mimeType,
      label_format: generated.format,
    })
  } catch (error) {
    console.error('Shipment label generation failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to generate shipment label'
    const statusCodeRaw = (error as { statusCode?: unknown })?.statusCode
    const details = (error as { details?: unknown })?.details
    const statusCode = typeof statusCodeRaw === 'number' && statusCodeRaw >= 400 && statusCodeRaw < 600
      ? statusCodeRaw
      : 500
    const explanationText = Array.isArray((details as any)?.compositeFault?.faults)
      ? (details as any).compositeFault.faults
          .map((fault: any) => String(fault?.explanationText || fault?.message || '').trim())
          .filter((value: string) => Boolean(value))
          .join(' | ')
      : undefined

    return res.status(statusCode).json({
      message,
      explanationText,
      details,
    })
  }
})

// ===== Shipment Track =====
app.get('/api/shipment/track/:trackingNumber', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const trackingNumber = String(req.params.trackingNumber || '').trim()
  if (!trackingNumber) {
    return res.status(400).json({ message: 'trackingNumber is required' })
  }

  try {
    await ensureSalesShipmentColumns()

    const tracked = await trackShipment(trackingNumber, {
      endpointPath: String(req.query.endpointPath || '').trim() || undefined,
      language: String(req.query.language || 'en').trim() || 'en',
    })

    const saleIdFromQuery = Number(req.query.sale_id)
    let targetSaleId: number | null = null

    if (Number.isFinite(saleIdFromQuery) && saleIdFromQuery > 0) {
      const [orderRows] = await db.query<RowDataPacket[]>(
        'SELECT id FROM sales WHERE id = ? AND seller_id = ? LIMIT 1',
        [saleIdFromQuery, auth.id],
      )
      if (orderRows.length) {
        targetSaleId = Number(orderRows[0].id)
      }
    }

    if (!targetSaleId && await hasSalesShipmentTrackingNumberColumn()) {
      const [trackingRows] = await db.query<RowDataPacket[]>(
        `SELECT id
         FROM sales
         WHERE seller_id = ? AND shipment_tracking_number = ?
         ORDER BY id DESC
         LIMIT 1`,
        [auth.id, trackingNumber],
      )
      if (trackingRows.length) {
        targetSaleId = Number(trackingRows[0].id)
      }
    }

    let updatedOrderStatus: string | null = null
    if (targetSaleId) {
      const nextStatus = resolveOrderStatusFromTracking(tracked)
      await db.query(
        'UPDATE sales SET order_status = ? WHERE id = ? AND seller_id = ?',
        [nextStatus, targetSaleId, auth.id],
      )
      updatedOrderStatus = nextStatus
    }

    return res.status(200).json({
      ...tracked,
      sale_id: targetSaleId,
      updated_order_status: updatedOrderStatus,
    })
  } catch (error) {
    console.error('Shipment tracking failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to track shipment'
    return res.status(500).json({ message })
  }
})

// ===== Generate Shipment Label (legacy endpoint, now backed by shipment module) =====
app.post('/api/orders/:id/generate-label', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const saleId = Number(req.params.id)
  if (!Number.isFinite(saleId) || saleId <= 0) {
    return res.status(400).json({ message: 'Invalid order id' })
  }

  try {
    const [orders] = await db.query<RowDataPacket[]>(
      `SELECT s.id, s.order_id,
              c.name, c.shipping_street, c.shipping_city, c.shipping_state, c.shipping_zip, c.shipping_country
       FROM sales s
       LEFT JOIN customers c ON s.customer_id = c.id
       WHERE s.id = ? AND s.seller_id = ?
       LIMIT 1`,
      [saleId, auth.id],
    )

    if (!orders.length) {
      return res.status(404).json({ message: 'Order not found' })
    }

    const order = orders[0]
    const senderAddress = await getSellerSenderAddress(auth.id)
    const address = {
      name: String(order.name || 'Customer'),
      street: String(order.shipping_street || '').trim(),
      postalCode: String(order.shipping_zip || '').trim(),
      city: String(order.shipping_city || '').trim(),
      countryCode: normalizeCountryCode(order.shipping_country || 'SE'),
    }

    const generated = await generateShipmentLabel({
      address,
      senderAddress,
      dimensions: { lengthCm: 20, widthCm: 20, heightCm: 10 },
      weightKg: 1,
      referenceNo: String(order.order_id || saleId),
    })

    await ensureShipmentLabelsTable()
    const labelsDir = path.join(__dirname, 'uploads', 'shipment_labels')
    if (!fs.existsSync(labelsDir)) {
      fs.mkdirSync(labelsDir, { recursive: true })
    }

    if (generated.contentBuffer) {
      const ext = generated.mimeType.includes('pdf') ? 'pdf' : generated.mimeType.startsWith('image/') ? 'png' : 'bin'
      const savedFileName = `label-${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`
      const savedFilePath = path.join(labelsDir, savedFileName)
      fs.writeFileSync(savedFilePath, generated.contentBuffer)
      const fileUrl = `/uploads/shipment_labels/${savedFileName}`

      await db.query<ResultSetHeader>(
        `INSERT INTO shipment_labels (
          sale_id,
          seller_id,
          order_id,
          booking_id,
          tracking_number,
          label_format,
          mime_type,
          file_name,
          file_path,
          file_size,
          file_url,
          provider
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'postnord')`,
        [
          saleId,
          auth.id,
          String(order.order_id || ''),
          generated.bookingId,
          generated.trackingNumber,
          generated.format,
          generated.mimeType,
          savedFileName,
          savedFilePath,
          generated.contentBuffer.length,
          fileUrl,
        ],
      )
    }

    const legacyUpdateFields: string[] = ['order_status = ?']
    const legacyUpdateValues: unknown[] = ['shipped']

    if (await hasSalesShipmentTrackingNumberColumn()) {
      legacyUpdateFields.push('shipment_tracking_number = ?')
      legacyUpdateValues.push(generated.trackingNumber || null)
    }
    if (await hasSalesShipmentLabelUrlColumn()) {
      const [latestLabelRows] = await db.query<RowDataPacket[]>(
        'SELECT file_url, mime_type, booking_id, created_at FROM shipment_labels WHERE sale_id = ? ORDER BY id DESC LIMIT 1',
        [saleId],
      )
      legacyUpdateFields.push('shipment_label_url = ?')
      legacyUpdateValues.push(latestLabelRows[0]?.file_url || null)

      if (await hasSalesShipmentLabelMimeTypeColumn()) {
        legacyUpdateFields.push('shipment_label_mime_type = ?')
        legacyUpdateValues.push(latestLabelRows[0]?.mime_type || null)
      }
      if (await hasSalesShipmentLabelGeneratedAtColumn()) {
        legacyUpdateFields.push('shipment_label_generated_at = ?')
        legacyUpdateValues.push(toCETDateTime(latestLabelRows[0]?.created_at))
      }
      if (await hasSalesShipmentBookingIdColumn()) {
        legacyUpdateFields.push('shipment_booking_id = ?')
        legacyUpdateValues.push(latestLabelRows[0]?.booking_id || generated.bookingId || null)
      }
    }

    legacyUpdateValues.push(saleId, auth.id)
    await db.query(
      `UPDATE sales SET ${legacyUpdateFields.join(', ')} WHERE id = ? AND seller_id = ?`,
      legacyUpdateValues,
    )

    await upsertShipmentLabelExpenseForSale(saleId, auth.id, null)

    return res.status(201).json({
      labelNumber: generated.bookingId || `LBL-${saleId}`,
      trackingNumber: generated.trackingNumber || null,
      order_id: order.order_id,
      generated_at: new Date().toISOString(),
      message: 'Shipment label generated successfully',
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: 'Database error' })
  }
})


// ===== Get Seller's Order Items =====
app.get('/api/orders/:id/products', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  const orderId = req.params.id

  try {
    // Verify order belongs to seller
    const [orders] = await db.query<RowDataPacket[]>(
      'SELECT id, seller_id FROM sales WHERE id = ?',
      [orderId]
    )

    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' })
    }

    if (orders[0].seller_id !== auth.id) {
      return res.status(403).json({ message: 'You do not have permission to view this order' })
    }

    // Get order items with product details
    const [items] = await db.query<RowDataPacket[]>(
      `SELECT
        si.id,
        si.product_type,
        si.product_id,
        si.product_name,
        si.quantity,
        si.unit_price,
        (si.unit_price * si.quantity) as total_price,
        si.tax_amount,
        p.category,
        p.brand,
        p.main_image_url
      FROM sale_items si
      LEFT JOIN products p ON si.product_id = p.id
      WHERE si.sale_id = ?`,
      [orderId]
    )

    res.status(200).json(items)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Database error' })
  }
})

// ===== Stripe PaymentIntent =====
app.post('/api/stripe/create-payment-intent', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  console.log('create-payment-intent:')
  const {
    amount,
    currency = 'sek',
    description = 'EVCS Payment',
    captureMethod = 'automatic',
  } = req.body

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ message: 'Valid amount is required' })
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount) * 100),
      currency,
      description,
      capture_method: captureMethod === 'manual' ? 'manual' : 'automatic',
      automatic_payment_methods: {
        enabled: true,
      },
    })

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      captureMethod: paymentIntent.capture_method,
    })
  } catch (err) {
    console.error('Stripe PaymentIntent error:', err)
    res.status(500).json({ message: 'Failed to create payment intent' })
  }
})

// ===== Stripe Reserve Payment (Manual Capture) =====
app.post('/api/stripe/reserve-payment', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  console.log('reserve-payment:')
  const { amount, currency = 'sek', description = 'EVCS Reservation' } = req.body

  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ message: 'Valid amount is required' })
  }

  try {
    const originalAmount = Math.round(Number(amount) * 100)
    const updatedAmount = Math.max(originalAmount - 500, 0) // minus $5

    const paymentIntent = await stripe.paymentIntents.create({
      amount: originalAmount,
      currency,
      description,
      capture_method: 'manual',
      automatic_payment_methods: {
        enabled: true,
      },
    })
    console.log('PaymentIntent created:', paymentIntent.amount)

    // respond immediately for client to authorize
    res.json({
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amountCents: originalAmount,
      amount: originalAmount / 100,
      updatedAmountCents: updatedAmount,
      updatedAmount: updatedAmount / 100,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
    })

    // schedule capture after 5 seconds
    setTimeout(async () => {
      try {
        const current = await stripe.paymentIntents.retrieve(paymentIntent.id)
        if (current.status === 'requires_capture') {
          const captured = await stripe.paymentIntents.capture(paymentIntent.id, {
            amount_to_capture: updatedAmount,
          })
          console.log('Payment captured:', updatedAmount)
        } else {
          console.log('Payment not ready to capture:', current.status)
        }
      } catch (err) {
        console.error('Capture error:', err)
      }
    }, 10000)
  } catch (err) {
    console.error('Stripe reserve error:', err)
    res.status(500).json({ message: 'Failed to reserve payment' })
  }
})

// ===== Stripe Checkout Session =====
app.post('/api/stripe/create-checkout-session', async (req: Request, res: Response) => {
  const auth = requireAuth(req, res)
  if (!auth) return

  console.log('create-checkout-session:')
  const { amount, currency = 'sek', description = 'EVCS Payment' } = req.body

  if (!amount || isNaN(amount)) {
    return res.status(400).json({ message: 'Valid amount is required' })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description },
            unit_amount: Math.round(Number(amount) * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${config.CLIENT_URL}/success`,
      cancel_url: `${config.CLIENT_URL}/cancel`,
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe error:', err)
    res.status(500).json({ message: 'Stripe session creation failed' })
  }
})

// ── Contact form ──────────────────────────────────────────────────────────────
// Simple in-memory rate limiter: max 3 submissions per IP per 15 minutes
const contactRateMap = new Map<string, { count: number; resetAt: number }>()
const CONTACT_RATE_LIMIT = 3
const CONTACT_RATE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

const contactRateLimit = (ip: string): boolean => {
  const now = Date.now()
  const entry = contactRateMap.get(ip)
  if (!entry || now > entry.resetAt) {
    contactRateMap.set(ip, { count: 1, resetAt: now + CONTACT_RATE_WINDOW_MS })
    return true // allowed
  }
  if (entry.count >= CONTACT_RATE_LIMIT) return false // blocked
  entry.count += 1
  return true
}

/** Strip all HTML/script tags and dangerous characters, then trim */
const sanitizeField = (value: unknown, maxLen: number): string => {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/[<>"'`\\;]/g, '')        // remove injection chars
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .slice(0, maxLen)
}

const VALID_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/
const VALID_ORDER_RE = /^[A-Za-z0-9\-_]{1,40}$/
const ALLOWED_REASONS = [
  'Order Issue',
  'Delivery / Shipping',
  'Return or Refund',
  'Payment Problem',
  'Product Question',
  'Account Support',
  'Other',
]

const ALLOWED_SUPPORT_TYPES = ['ask_question', 'report_issue', 'give_feedback'] as const
type SellerSupportType = (typeof ALLOWED_SUPPORT_TYPES)[number]

const SUPPORT_TYPE_LABELS: Record<SellerSupportType, string> = {
  ask_question: 'Ask a question',
  report_issue: 'Report issue',
  give_feedback: 'Give feedback',
}

app.post('/api/seller/support', supportUpload, async (req: Request, res: Response) => {
  const auth = await requireSellerOrAdmin(req, res)
  if (!auth) return

  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim()

  if (!contactRateLimit(ip)) {
    return res.status(429).json({
      message: 'Too many messages. Please wait 15 minutes before sending again.',
    })
  }

  const sellerName = sanitizeField(req.body?.sellerName, 100)
  const sellerEmailFromBody = sanitizeField(req.body?.sellerEmail, 150).toLowerCase()
  const subject = sanitizeField(req.body?.subject, 120)
  const type = sanitizeField(req.body?.type, 40).toLowerCase() as SellerSupportType
  const description = sanitizeField(req.body?.description, 2000)

  if (!sellerName || sellerName.length < 2) {
    return res.status(400).json({ message: 'Seller name is required (at least 2 characters).' })
  }

  if (!subject || subject.length < 3) {
    return res.status(400).json({ message: 'Subject is required (at least 3 characters).' })
  }

  if (!ALLOWED_SUPPORT_TYPES.includes(type)) {
    return res.status(400).json({ message: 'Please choose a valid support type.' })
  }

  if (!description || description.length < 10) {
    return res.status(400).json({ message: 'Description is too short (at least 10 characters).' })
  }

  const supportEmail = config.EMAIL.address || config.SMTP.user || ''
  if (!supportEmail) {
    console.error('[Seller Support] EMAIL_ADDRESS env variable is not set.')
    return res.status(500).json({ message: 'Support email is not configured. Please try again later.' })
  }

  try {
    const [userRows] = await db.query<RowDataPacket[]>(
      'SELECT email, role FROM users WHERE id = ? LIMIT 1',
      [auth.id],
    )

    const sellerEmailFromDb = sanitizeField(userRows[0]?.email, 150).toLowerCase()
    const sellerEmail = sellerEmailFromDb || sellerEmailFromBody

    if (!sellerEmail || !VALID_EMAIL_RE.test(sellerEmail)) {
      return res.status(400).json({ message: 'A valid seller email is required.' })
    }

    const supportTypeLabel = SUPPORT_TYPE_LABELS[type]
    const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : []
    const attachmentList = files.length
      ? `<ul>${files.map((file) => `<li>${file.originalname}</li>`).join('')}</ul>`
      : '<p>No attachments.</p>'

    const emailBody = `
<h2 style="font-family:sans-serif;color:#1e1b4b;">New Seller Support Message</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;max-width:650px;">
  <tr><td style="padding:8px 12px;font-weight:600;color:#374151;width:170px;">Seller name</td><td style="padding:8px 12px;color:#111827;">${sellerName}</td></tr>
  <tr style="background:#f9fafb;"><td style="padding:8px 12px;font-weight:600;color:#374151;">Seller email</td><td style="padding:8px 12px;color:#111827;">${sellerEmail}</td></tr>
  <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Support type</td><td style="padding:8px 12px;color:#111827;">${supportTypeLabel}</td></tr>
  <tr style="background:#f9fafb;"><td style="padding:8px 12px;font-weight:600;color:#374151;">Subject</td><td style="padding:8px 12px;color:#111827;">${subject}</td></tr>
  <tr>
    <td style="padding:8px 12px;font-weight:600;color:#374151;vertical-align:top;">Description</td>
    <td style="padding:8px 12px;color:#111827;white-space:pre-wrap;">${description}</td>
  </tr>
  <tr style="background:#f9fafb;">
    <td style="padding:8px 12px;font-weight:600;color:#374151;vertical-align:top;">Attachments</td>
    <td style="padding:8px 12px;color:#111827;">${attachmentList}</td>
  </tr>
</table>
<p style="font-family:sans-serif;font-size:12px;color:#9ca3af;margin-top:24px;">Sent from seller support panel.</p>
    `.trim()

    await ensureSupportMessagesTable()

    await db.query(
      `INSERT INTO support_messages (
        sender_name,
        sender_email,
        sender_role,
        sender_user_id,
        recipient_role,
        subject,
        order_id,
        message
      ) VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
      [
        sellerName,
        sellerEmail,
        auth.role,
        auth.id,
        `${supportTypeLabel}: ${subject}`,
        null,
        description,
      ],
    )

    await sendEmail(
      supportEmail,
      `[Seller Support] ${supportTypeLabel} - ${subject}`,
      emailBody,
      {
        attachments: files.map((file) => ({
          filename: file.originalname,
          path: file.path,
          contentType: file.mimetype,
        })),
      },
    )

    return res.json({ success: true, message: 'Support message sent to admin.' })
  } catch (error) {
    console.error('[Seller Support] Failed to process support request:', error)
    return res.status(500).json({ message: 'Could not send support message at this time. Please try again later.' })
  }
})

app.post('/api/public/newsletter/subscribe', async (req: Request, res: Response) => {
  try {
    const email = sanitizeField(req.body?.email, 255).toLowerCase()
    const source = sanitizeField(req.body?.source, 50) || 'footer'

    if (!email || !VALID_EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'A valid email address is required.' })
    }

    await db.query(
      `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        source VARCHAR(50) DEFAULT 'footer',
        subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_newsletter_email (email),
        INDEX idx_newsletter_active (is_active),
        INDEX idx_newsletter_subscribed_at (subscribed_at)
      ) AUTO_INCREMENT = 100`,
    )

    await db.query(
      `INSERT INTO newsletter_subscribers (email, is_active, source)
       VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE
         is_active = 1,
         source = VALUES(source),
         updated_at = CURRENT_TIMESTAMP`,
      [email, source],
    )

    return res.json({
      success: true,
      message: 'Subscribed successfully. You will receive weekly deals.',
    })
  } catch (error) {
    console.error('[Newsletter] Subscription failed:', error)
    return res.status(500).json({ message: 'Could not subscribe right now. Please try again later.' })
  }
})

app.post('/api/contact', async (req: Request, res: Response) => {
  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim()

  if (!contactRateLimit(ip)) {
    return res.status(429).json({
      message: 'Too many messages. Please wait 15 minutes before sending again.',
    })
  }

  const name    = sanitizeField(req.body.name,    100)
  const email   = sanitizeField(req.body.email,   150)
  const orderId = sanitizeField(req.body.orderId, 40)
  const reason  = sanitizeField(req.body.reason,  80)
  const message = sanitizeField(req.body.message, 2000)

  // Validate required fields
  if (!name || name.length < 2)
    return res.status(400).json({ message: 'Name is required (at least 2 characters).' })

  if (!email || !VALID_EMAIL_RE.test(email))
    return res.status(400).json({ message: 'A valid email address is required.' })

  if (orderId && !VALID_ORDER_RE.test(orderId))
    return res.status(400).json({ message: 'Order ID contains invalid characters.' })

  if (!reason || !ALLOWED_REASONS.includes(reason))
    return res.status(400).json({ message: 'Please select a valid reason.' })

  if (!message || message.length < 10)
    return res.status(400).json({ message: 'Message is too short (at least 10 characters).' })

  const supportEmail = config.EMAIL.address || config.SMTP.user || ''

  if (!supportEmail) {
    console.error('[Contact] EMAIL_ADDRESS env variable is not set.')
    return res.status(500).json({ message: 'Support email is not configured. Please try again later.' })
  }

  const orderLine = orderId ? `\nOrder ID:  ${orderId}` : ''

  const emailBody = `
<h2 style="font-family:sans-serif;color:#1e1b4b;">New Contact Form Submission</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;max-width:600px;">
  <tr><td style="padding:8px 12px;font-weight:600;color:#374151;width:150px;">Name</td><td style="padding:8px 12px;color:#111827;">${name}</td></tr>
  <tr style="background:#f9fafb;"><td style="padding:8px 12px;font-weight:600;color:#374151;">Email</td><td style="padding:8px 12px;color:#111827;">${email}</td></tr>
  ${orderId ? `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Order ID</td><td style="padding:8px 12px;color:#111827;">${orderId}</td></tr>` : ''}
  <tr style="background:#f9fafb;"><td style="padding:8px 12px;font-weight:600;color:#374151;">Reason</td><td style="padding:8px 12px;color:#111827;">${reason}</td></tr>
  <tr>
    <td style="padding:8px 12px;font-weight:600;color:#374151;vertical-align:top;">Message</td>
    <td style="padding:8px 12px;color:#111827;white-space:pre-wrap;">${message}</td>
  </tr>
</table>
<p style="font-family:sans-serif;font-size:12px;color:#9ca3af;margin-top:24px;">Sent from the contact form on ShopHub.com</p>
  `.trim()

  try {
    await ensureSupportMessagesTable()

    const token = getAuthToken(req)
    let senderUserId: number | null = null
    let senderRole: 'guest' | 'buyer' | 'seller' | 'admin' = 'guest'

    if (token) {
      try {
        const decoded = jwt.verify(token, config.JWT_SECRET) as AuthPayload
        senderUserId = decoded.id

        const [userRows] = await db.query<RowDataPacket[]>(
          'SELECT role FROM users WHERE id = ? LIMIT 1',
          [decoded.id],
        )

        const dbRole = String(userRows[0]?.role || '').toLowerCase()
        if (dbRole === 'buyer' || dbRole === 'seller' || dbRole === 'admin') {
          senderRole = dbRole
        }
      } catch {
        senderUserId = null
        senderRole = 'guest'
      }
    }

    await db.query(
      `INSERT INTO support_messages (
        sender_name,
        sender_email,
        sender_role,
        sender_user_id,
        recipient_role,
        subject,
        order_id,
        message
      ) VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
      [
        name,
        email,
        senderRole,
        senderUserId,
        reason,
        orderId || null,
        message,
      ],
    )

    await sendEmail(
      supportEmail,
      `[Support] ${reason} – from ${name}`,
      emailBody,
    )
    console.log(`[Contact] Email forwarded to ${supportEmail} from ${email}${orderLine}`)
    return res.json({ success: true, message: 'Your message has been sent. We will be in touch soon.' })
  } catch (err: any) {
    console.error('[Contact] Failed to send email:', err)
    return res.status(500).json({ message: 'Could not send your message at this time. Please try again later.' })
  }
})

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum allowed size is 5MB.'
      : err.message
    return res.status(400).json({ message })
  }

  if (err) {
    return res.status(400).json({ message: err.message || 'Request failed' })
  }

  next()
})

const DEFAULT_PORT = config.PORT

const startServer = (port: number) => {
  const server = app.listen(port, '0.0.0.0', () => {
    setupWebSocket(server)
    console.log(`Server running on http://0.0.0.0:${port}`)
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('Failed to start server:', error)
    process.exit(1)
  })
}

startServer(DEFAULT_PORT)