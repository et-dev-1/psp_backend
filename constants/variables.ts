import * as config from '../config'

export const DEFAULT_VAT_SHIPPING_RATE = config.VAT_SHIPPING_RATE

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
export const AUTH_CAPTCHA_TTL_MS = 10 * 60 * 1000
export const SMTP_PASSWORD_SETTING_KEY = 'smtp_password_encrypted'

export const PRODUCT_UPLOAD_SUBDIR = 'products'
export const SUPPORT_UPLOAD_SUBDIR = 'support'
export const DISPUTE_UPLOAD_SUBDIR = 'disputes'
export const COMPANY_LOGO_UPLOAD_SUBDIR = 'company_logos'
export const CUSTOMIZATION_UPLOAD_SUBDIR = 'customizations'

export const DISPUTE_ALLOWED_EXTS = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|jfif|ico|pdf|txt|docx?)$/i
export const DISPUTE_ALLOWED_MIMES =
  /^(image\/(?!svg\+xml)[a-z0-9.+-]+|application\/pdf|text\/plain|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i

export const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export const SUPPORT_TYPE_LABELS: Record<string, string> = {
  ask_question: 'Ask a Question',
  report_issue: 'Report an Issue',
  give_feedback: 'Give Feedback',
}
