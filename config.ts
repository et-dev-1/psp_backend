import dotenv from 'dotenv'

dotenv.config()

const toBool = (val?: string, defaultVal = false): boolean => {
  if (val === undefined || val === null) return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(val).toLowerCase())
}

const toNumber = (val: string | undefined, fallback: number): number => {
  if (val === undefined || val === null || String(val).trim() === '') return fallback
  const parsed = Number(val)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()

export const JWT_SECRET = String(process.env.JWT_SECRET || '')
export const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '')
export const CLIENT_URL = String(process.env.CLIENT_URL || '')
export const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim()
export const NODE_ENV = process.env.NODE_ENV || 'development'
export const DISABLE_AUTH_CHECK = toBool(process.env.DISABLE_AUTH_CHECK)
export const DETAILED_LOGGING = toBool(process.env.DETAILED_LOGGING, false)
// CONTACT_EMAIL is derived from EMAIL_ADDRESS — set EMAIL_ADDRESS in .env
export const CONTACT_EMAIL = String(process.env.EMAIL_ADDRESS || '')
export const PORT = Number(process.env.PORT || 3000)
export const DISABLE_AUTH_RATE_LIMIT = toBool(process.env.DISABLE_AUTH_RATE_LIMIT, false)
export const BACKEND_PUBLIC_BASE_URL = String(process.env.BACKEND_PUBLIC_BASE_URL || '').trim()
export const POSTNORD_TRACKING_BASE_URL = String(process.env.POSTNORD_TRACKING_BASE_URL || '').trim()

export const SMTP = {
  host: process.env.EMAIL_HOST || 'smtp.hostinger.com',
  port: Number(process.env.EMAIL_PORT || 465),
  secure: process.env.EMAIL_SECURE ? process.env.EMAIL_SECURE === 'true' : Number(process.env.EMAIL_PORT || 465) === 465,
  user: process.env.EMAIL_USER || process.env.EMAIL_ADDRESS || '',
  pass: process.env.EMAIL_PASS || '',
  fromName: process.env.EMAIL_FROM_NAME || 'SellingPlatform',
}

export const EMAIL = {
  address: process.env.EMAIL_ADDRESS || '',
  companyName: process.env.EMAIL_COMPANY_NAME || 'Smart Embedded System',
  companyAddress: process.env.EMAIL_COMPANY_ADDRESS || '',
  companyLogoUrl: String(process.env.EMAIL_COMPANY_LOGO_URL || ''),
  useTestReceiver: toBool(process.env.EMAIL_USE_TEST_RECEIVER, false),
  testReceiver: String(process.env.EMAIL_TEST_RECEIVER || ''),
}

export const COMPANY_ORGANIZATION_NUMBER = String(process.env.COMPANY_ORGANIZATION_NUMBER || '')

export const POSTNORD = {
  apiKey: String(process.env.POSTNORD_API_KEY || ''),
  customerNumber: String(process.env.POSTNORD_CUSTOMER_NUMBER || ''),
  usePortalPricing: toBool(process.env.POSTNORD_USE_PORTAL_PRICING, false),
  enableTransitTime: toBool(process.env.POSTNORD_ENABLE_TRANSIT_TIME, false),
  // Enable verbose request/response logs for label + tracking calls.
  // Set POSTNORD_DEBUG_LOGS=false to silence these logs.
  debugLogs: toBool(process.env.POSTNORD_DEBUG_LOGS, NODE_ENV !== 'production'),
}

export const DEFAULT_PLATFORM_COMMISSION_PERCENT = Number(process.env.DEFAULT_PLATFORM_COMMISSION_PERCENT || '1')
export const DEFAULT_PLATFORM_COMMISSION_FIXED = Number(process.env.DEFAULT_PLATFORM_COMMISSION_FIXED || '0')
export const VAT_SHIPPING_RATE = Number(process.env.VAT_SHIPPING_RATE || '0.25')
export const PROMOTION_COMMISSION_PERCENT = toNumber(process.env.PROMOTION_COMMISSION_PERCENT, 5)
// Swish requires certificates and is usually disabled unless explicitly configured.
export const SWISH_ENABLED = toBool(process.env.SWISH_ENABLED, false)
export const SWISH_TEST_MODE = toBool(process.env.SWISH_TEST_MODE, true)

// CORS origin check is ALWAYS enabled unless explicitly disabled via env.
export const DISABLE_CORS_ORIGIN_CHECK = toBool(process.env.DISABLE_CORS_ORIGIN_CHECK, false)

// Development-only fallback origins (never used in production).
const DEV_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
]

const ENV_CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : []

// In production: require explicit CORS_ORIGINS or CLIENT_URL — no implicit fallback.
// In development: fall back to localhost dev ports if nothing is configured.
export const CORS_ORIGINS: string[] = ENV_CORS_ORIGINS.length
  ? ENV_CORS_ORIGINS
  : NODE_ENV === 'production'
    ? CLIENT_URL ? [CLIENT_URL] : []   // empty = block all origins in prod if misconfigured
    : DEV_CORS_ORIGINS

// Checks whether an origin is permitted.
// Production: strict whitelist only (CORS_ORIGINS env).
// Development: also allows private-network IPs on common Vite ports.
export const isOriginAllowed = (origin: string | undefined): boolean => {
  if (DISABLE_CORS_ORIGIN_CHECK) return true
  if (!origin) return false

  // Explicit whitelist (CORS_ORIGINS / CLIENT_URL from env)
  if (CORS_ORIGINS.includes(origin)) return true

  // In development only: also allow any private-network IP on Vite dev ports
  if (NODE_ENV !== 'production') {
    try {
      const url = new URL(origin)
      const isPrivateIP =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(url.hostname)
      const isFrontendPort = ['5173', '5174', '5175'].includes(url.port)
      return isPrivateIP && isFrontendPort
    } catch {
      return false
    }
  }

  return false
}
