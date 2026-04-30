import https from 'https'
import { IncomingHttpHeaders } from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

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
  private agent: https.Agent

  constructor(config: SwishApiConfig = {}) {
    this.testMode = config.testMode !== false
    const explicitBaseHost = getTrimmedEnv('SWISH_BASE_HOST')
    if (explicitBaseHost) {
      this.baseHost = explicitBaseHost
    } else if (this.testMode) {
      this.baseHost = getRequiredEnv('SWISH_TEST_HOST')
    } else {
      this.baseHost = getRequiredEnv('SWISH_PRODUCTION_HOST')
    }

    const certPath = config.certificatePath || path.join(__dirname, 'swish_client_cert')
    const certificatePassword = config.certificatePassword || 'swish'

    // Use p12 to honor the certificate passphrase provided by Swish test certs.
    const p12FilePath = path.join(certPath, 'Swish_Merchant_TestCertificate_1234679304.p12')
    const caFilePath = path.join(certPath, 'Swish_TLS_RootCA.pem')

    if (!fs.existsSync(p12FilePath)) {
      throw new Error(`Client p12 certificate not found: ${p12FilePath}`)
    }
    if (!fs.existsSync(caFilePath)) {
      throw new Error(`Root CA certificate not found: ${caFilePath}`)
    }

    this.agent = new https.Agent({
      pfx: fs.readFileSync(p12FilePath),
      passphrase: certificatePassword,
      ca: fs.readFileSync(caFilePath, 'utf-8'),
      rejectUnauthorized: true,
    })
  }

  /**
   * Swish instructionUUID must match [0-9A-F]{32}.
   */
  private generateUUID(): string {
    return crypto.randomBytes(16).toString('hex').toUpperCase()
  }

  private async request<T>(method: 'GET' | 'PUT', relativePath: string, body?: unknown): Promise<{
    statusCode: number
    headers: IncomingHttpHeaders
    data: T
  }> {
    const url = new URL(`${this.baseHost}${relativePath}`)
    const payload = body ? JSON.stringify(body) : undefined

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
            'Content-Type': 'application/json',
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

      const response = await this.request<unknown>('PUT', `/swish-cpcapi/api/v2/paymentrequests/${instructionId}`, {
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
      const response = await this.request<unknown>('GET', `/swish-cpcapi/api/v1/paymentrequests/${instructionId}`)

      console.log('[Swish API] Payment status retrieved:', {
        instructionId,
        status: typeof response.data === 'object' ? (response.data as Record<string, unknown>).status : undefined,
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

      const response = await this.request<unknown>('PUT', `/swish-cpcapi/api/v2/refunds/${refundId}`, {
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
