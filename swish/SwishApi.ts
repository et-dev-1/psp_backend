import https from 'https'
import { IncomingHttpHeaders } from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import tls from 'tls'

const getTrimmedEnv = (key: string): string | undefined => {
  const raw = process.env[key]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const getRequiredEnv = (key: string): string => {
  const value = getTrimmedEnv(key)
  if (value === undefined) {
    throw new Error(`${key} is not set`)
  }
  return value
}

const getBooleanEnv = (key: string, defaultValue = false): boolean => {
  const value = getTrimmedEnv(key)
  if (value === undefined) return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

interface PaymentRequest {
  payeePaymentReference: string
  callbackUrl: string
  payeeAlias: string
  currency: string
  payerAlias?: string
  amount: string | number
  message: string
  callbackIdentifier?: string
}

interface PaymentResponse {
  instructionUUID?: string
  id?: string
  location?: string
  paymentRequestToken?: string
}

interface CancelPaymentResponse {
  instructionUUID: string
  statusCode: number
}

interface SwishApiError {
  code: number | 'UNKNOWN'
  message: string
  details?: unknown
}

interface SwishApiConfig {
  testMode?: boolean
  certificatePath?: string
  certificatePassword?: string
}

/**
 * Swish Commerce API Integration
 * Uses TLS client certificates for mutual authentication
 * Test environment: https://mss.cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/{instructionId}
 * Production: https://cpc.getswish.net/swish-cpcapi/api/v2/paymentrequests/{instructionId}
 */
class SwishApi {
  private testMode: boolean
  private baseHost: string
  private apiBasePath: string
  private agent: https.Agent

  constructor(config: SwishApiConfig = {}) {
    this.testMode = getBooleanEnv('SWISH_TEST_MODE', false)
    this.baseHost = getRequiredEnv('SWISH_BASE_HOST')
    this.apiBasePath = getTrimmedEnv('SWISH_API_BASE_PATH') || '/swish-cpcapi/api'

    const certificatePassword = getRequiredEnv('SWISH_CERTIFICATE_PASSWORD')

    // Use p12 to honor the certificate passphrase provided by Swish test certs.
    const certDir = path.resolve(getRequiredEnv('SWISH_CERTIFICATE_PATH'))
    const p12FilePath = path.resolve(certDir, getRequiredEnv('SWISH_P12_FILENAME'))
    const caFileName = getTrimmedEnv('SWISH_CA_FILENAME')
    const caFilePath = caFileName ? path.resolve(certDir, caFileName) : undefined

    if (!fs.existsSync(p12FilePath)) {
      throw new Error(`Client p12 certificate not found: ${p12FilePath}`)
    }

    const caCertificates: string[] = [...tls.rootCertificates]
    if (caFilePath) {
      if (!fs.existsSync(caFilePath)) {
        throw new Error(`CA certificate not found: ${caFilePath}`)
      }
      caCertificates.push(fs.readFileSync(caFilePath, 'utf-8'))
    }

    this.agent = new https.Agent({
      pfx: fs.readFileSync(p12FilePath),
      passphrase: certificatePassword,
      ca: caCertificates,
      rejectUnauthorized: true,
    })
  }

  private buildApiPath(version: 'v1' | 'v2', resourcePath: string): string {
    const base = this.apiBasePath.startsWith('/') ? this.apiBasePath : `/${this.apiBasePath}`
    const normalizedBase = base.replace(/\/+$/, '')
    const normalizedResource = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`
    return `${normalizedBase}/${version}${normalizedResource}`
  }

  /**
   * Swish instructionUUID must match [0-9A-F]{32}.
   */
  private generateUUID(): string {
    return crypto.randomBytes(16).toString('hex').toUpperCase()
  }

  private async request<T>(method: 'GET' | 'PUT' | 'PATCH', relativePath: string, body?: unknown, contentType?: string): Promise<{
    statusCode: number
    headers: IncomingHttpHeaders
    data: T
  }> {
    const url = new URL(`${this.baseHost}${relativePath}`)
    const payload = body ? JSON.stringify(body) : undefined
    const resolvedContentType = contentType || 'application/json'

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          agent: this.agent,
          timeout: 15000,
          headers: {
            'Content-Type': resolvedContentType,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []

          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const statusCode = res.statusCode || 0
            const raw = Buffer.concat(chunks).toString('utf-8')
            const isJson = String(res.headers['content-type'] || '').includes('application/json')
            const parsed = raw
              ? isJson
                ? JSON.parse(raw)
                : raw
              : null

            if (statusCode >= 200 && statusCode < 300) {
              resolve({ statusCode, headers: res.headers, data: parsed as T })
              return
            }

            const errorMessage =
              typeof parsed === 'object' && parsed && 'error' in (parsed as Record<string, unknown>)
                ? String((parsed as Record<string, unknown>).error)
                : `Swish API request failed (${statusCode})`

            reject({
              code: statusCode,
              message: errorMessage,
              details: parsed,
            } satisfies SwishApiError)
          })
        },
      )

      req.on('timeout', () => {
        req.destroy(new Error('Swish API request timed out'))
      })

      req.on('error', (err) => {
        reject({
          code: 'UNKNOWN',
          message: err.message || 'Swish API network error',
        } satisfies SwishApiError)
      })

      if (payload) req.write(payload)
      req.end()
    })
  }

  /**
   * Create a payment request
   * Sends PUT request to Swish API with payment details
   *
   * @param request - Payment request details
   * @returns Payment response with instruction UUID and token
   */
  async createPaymentRequest(request: PaymentRequest): Promise<PaymentResponse> {
    try {
      const instructionId = this.generateUUID()

      console.log('[Swish API] Creating payment request:', {
        instructionId,
        amount: request.amount,
        payeeAlias: request.payeeAlias,
        testMode: this.testMode,
      })

      const response = await this.request<unknown>('PUT', this.buildApiPath('v2', `/paymentrequests/${instructionId}`), {
        payeePaymentReference: request.payeePaymentReference,
        callbackUrl: request.callbackUrl,
        payeeAlias: request.payeeAlias,
        currency: request.currency,
        payerAlias: request.payerAlias || undefined,
        amount: String(request.amount),
        message: request.message,
        callbackIdentifier: request.callbackIdentifier || undefined,
      })

      console.log('[Swish API] Payment request created successfully:', {
        instructionId,
        status: response.statusCode,
        headers: response.headers,
      })

      return {
        instructionUUID: instructionId,
        id: String(response.headers.location || instructionId),
        location: String(response.headers.location || ''),
        paymentRequestToken: Array.isArray(response.headers.paymentrequesttoken)
          ? String(response.headers.paymentrequesttoken[0] || '')
          : String(response.headers.paymentrequesttoken || ''),
      }
    } catch (error: unknown) {
      const normalized = error as SwishApiError

      console.error('[Swish API] Error creating payment request:', {
        status: normalized.code,
        data: normalized.details,
        message: normalized.message,
      })

      throw normalized
    }
  }

  /**
   * Get payment request status
   * Retrieves the current status of a payment request
   *
   * @param instructionId - UUID of the payment request
   * @returns Payment request status and details
   */
  async getPaymentStatus(instructionId: string): Promise<unknown> {
    try {
      let response: Awaited<ReturnType<typeof this.request<unknown>>>
      try {
        response = await this.request<unknown>('GET', this.buildApiPath('v2', `/paymentrequests/${instructionId}`))
      } catch (error: unknown) {
        const normalized = error as SwishApiError
        // Some Swish environments still expose GET status on v1 only.
        if (normalized.code === 405) {
          response = await this.request<unknown>('GET', this.buildApiPath('v1', `/paymentrequests/${instructionId}`))
        } else {
          throw error
        }
      }

      console.log('[Swish API] Payment status retrieved:', {
        instructionId,
        httpStatus: response.statusCode,
        headers: response.headers,
        status: typeof response.data === 'object' ? (response.data as Record<string, unknown>).status : undefined,
        response: response.data,
      })

      return response.data
    } catch (error: unknown) {
      const normalized = error as SwishApiError

      console.error('[Swish API] Error retrieving payment status:', {
        instructionId,
        status: normalized.code,
        message: normalized.message,
      })

      throw normalized
    }
  }

  /**
   * Cancel an ongoing payment request.
   * Swish expects an update to the existing payment request status.
   */
  async cancelPaymentRequest(instructionId: string): Promise<CancelPaymentResponse> {
    try {
      // Swish Commerce API: cancel via PATCH with JSON Patch document
      // PATCH /swish-cpcapi/api/v1/paymentrequests/{id}
      // Content-Type: application/json-patch+json
      // Body: [{"op":"replace","path":"/status","value":"cancelled"}]
      const jsonPatch = [{ op: 'replace', path: '/status', value: 'cancelled' }]
      const response = await this.request<unknown>(
        'PATCH',
        this.buildApiPath('v1', `/paymentrequests/${instructionId}`),
        jsonPatch,
        'application/json-patch+json',
      )

      return {
        instructionUUID: instructionId,
        statusCode: response.statusCode,
      }
    } catch (error: unknown) {
      const normalized = error as SwishApiError

      console.error('[Swish API] Error cancelling payment request:', {
        instructionId,
        status: normalized.code,
        message: normalized.message,
        details: normalized.details,
      })

      throw normalized
    }
  }

  /**
   * Create a refund request
   * Issues a refund for a previously completed payment
   *
   * @param originalInstuctionId - UUID of original payment request
   * @param amount - Refund amount (partial or full)
   * @param callbackUrl - Callback URL for refund status updates
   * @returns Refund response with instruction UUID
   */
  async createRefund(
    originalInstuctionId: string,
    amount: string | number,
    callbackUrl: string,
  ): Promise<PaymentResponse> {
    try {
      const refundId = this.generateUUID()

      console.log('[Swish API] Creating refund request:', {
        refundId,
        originalInstructionId: originalInstuctionId,
        amount,
      })

      const response = await this.request<unknown>('PUT', this.buildApiPath('v2', `/refunds/${refundId}`), {
        originalInstructionUUID: originalInstuctionId,
        callbackUrl,
        amount: String(amount),
      })

      console.log('[Swish API] Refund request created successfully:', {
        refundId,
        status: response.statusCode,
      })

      return {
        instructionUUID: refundId,
        id: String(response.headers.location || refundId),
        location: String(response.headers.location || ''),
      }
    } catch (error: unknown) {
      const normalized = error as SwishApiError

      console.error('[Swish API] Error creating refund:', {
        originalInstructionId: originalInstuctionId,
        status: normalized.code,
        message: normalized.message,
      })

      throw normalized
    }
  }

  /**
   * Get test environment info
   */
  getEnvironmentInfo(): {
    testMode: boolean
    baseHost: string
  } {
    return {
      testMode: this.testMode,
      baseHost: this.baseHost,
    }
  }
}

export default SwishApi
export type { PaymentRequest, PaymentResponse, SwishApiConfig }
