import { Server } from 'socket.io'
import { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { JWT_SECRET, CORS_ORIGINS } from './config'

interface AuthableSocket {
  id: string
  userId?: number
  userRole?: 'admin' | 'seller'
}

export interface WebhookEventPayload {
  [key: string]: unknown
}

export type WebhookEventType =
  | 'order:created'
  | 'order:updated'
  | 'order:status-changed'
  | 'payment:processed'
  | 'payout:approved'
  | 'product:approved'
  | 'product:rejected'
  | 'profile:updated'
  | 'profile:verified'
  | 'notification:new'

let io: Server | null = null
const activeConnections = new Map<number, Set<string>>() // userId -> Set of socketIds

export const setupWebSocket = (httpServer: HttpServer): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: CORS_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token
    
    if (!token) {
      return next(new Error('Authentication error: Missing token'))
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { id: number }
      ;(socket as AuthableSocket).userId = decoded.id
      return next()
    } catch (err) {
      return next(new Error('Authentication error: Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    const authSocket = socket as AuthableSocket
    const userId = authSocket.userId!

    console.log(`✅ User ${userId} connected with socket ${socket.id}`)

    // Track active connections
    if (!activeConnections.has(userId)) {
      activeConnections.set(userId, new Set())
    }
    activeConnections.get(userId)!.add(socket.id)

    // Join user room for targeted notifications
    socket.join(`user:${userId}`)

    // Handle disconnection
    socket.on('disconnect', () => {
      const connections = activeConnections.get(userId)
      connections?.delete(socket.id)
      
      if (connections?.size === 0) {
        activeConnections.delete(userId)
        console.log(`🚪 User ${userId} fully disconnected`)
      }
    })

    // Handle subscription to updates
    socket.on('subscribe:orders', (data: { role: 'admin' | 'seller' }) => {
      authSocket.userRole = data.role
      
      if (data.role === 'admin') {
        socket.join('admin-notifications')
        socket.join('admin-orders')
      } else {
        socket.join(`seller:${userId}`)
        socket.join(`seller-orders:${userId}`)
      }
      
      socket.emit('subscribed', { channel: 'orders', role: data.role })
      console.log(`📨 User ${userId} (${data.role}) subscribed to orders`)
    })

    socket.on('subscribe:payments', (data: { role: 'admin' | 'seller' }) => {
      if (data.role === 'admin') {
        socket.join('admin-payments')
      } else {
        socket.join(`seller-payments:${userId}`)
      }
      socket.emit('subscribed', { channel: 'payments', role: data.role })
    })

    socket.on('subscribe:products', (data: { role: 'admin' | 'seller' }) => {
      if (data.role === 'admin') {
        socket.join('admin-products')
      } else {
        socket.join(`seller-products:${userId}`)
      }
      socket.emit('subscribed', { channel: 'products', role: data.role })
    })

    socket.on('error', (error) => {
      console.error(`Socket error for user ${userId}:`, error)
    })
  })

  return io
}

export const getIO = (): Server => {
  if (!io) {
    throw new Error('WebSocket not initialized')
  }
  return io
}

export const emitWebhook = (event: WebhookEventType, payload: WebhookEventPayload, targets?: { role?: 'admin' | 'seller'; userId?: number }) => {
  if (!io) {
    console.warn('WebSocket not initialized, skipping webhook emit')
    return
  }

  const eventRoom = getEventRoom(event, targets)
  console.log(`📤 Emitting webhook: ${event} to ${eventRoom}`)
  
  io.to(eventRoom).emit(event, {
    timestamp: new Date().toISOString(),
    ...payload,
  })
}

export const emitToUser = (userId: number, event: WebhookEventType, payload: WebhookEventPayload) => {
  if (!io) {
    console.warn('WebSocket not initialized, skipping user webhook emit')
    return
  }

  console.log(`📤 Emitting to user ${userId}: ${event}`)
  io.to(`user:${userId}`).emit(event, {
    timestamp: new Date().toISOString(),
    ...payload,
  })
}

export const emitToAdmin = (event: WebhookEventType, payload: WebhookEventPayload) => {
  if (!io) {
    console.warn('WebSocket not initialized, skipping admin webhook emit')
    return
  }

  console.log(`📤 Emitting to admins: ${event}`)
  io.to('admin-notifications').emit(event, {
    timestamp: new Date().toISOString(),
    ...payload,
  })
}

export const emitToSeller = (sellerId: number, event: WebhookEventType, payload: WebhookEventPayload) => {
  if (!io) {
    console.warn('WebSocket not initialized, skipping seller webhook emit')
    return
  }

  console.log(`📤 Emitting to seller ${sellerId}: ${event}`)
  io.to(`seller:${sellerId}`).emit(event, {
    timestamp: new Date().toISOString(),
    ...payload,
  })
}

const getEventRoom = (event: WebhookEventType, targets?: { role?: 'admin' | 'seller'; userId?: number }): string => {
  switch (event) {
    case 'order:created':
    case 'order:updated':
    case 'order:status-changed':
      if (targets?.role === 'admin') return 'admin-notifications'
      if (targets?.userId) return `seller:${targets.userId}`
      return 'admin-notifications'
    
    case 'payment:processed':
    case 'payout:approved':
      if (targets?.role === 'admin') return 'admin-payments'
      if (targets?.userId) return `seller-payments:${targets.userId}`
      return 'admin-payments'
    
    case 'product:approved':
    case 'product:rejected':
      if (targets?.role === 'admin') return 'admin-products'
      if (targets?.userId) return `seller-products:${targets.userId}`
      return 'admin-products'
    
    case 'profile:updated':
    case 'profile:verified':
      return 'admin-notifications'
    
    case 'notification:new':
    default:
      if (targets?.userId) return `user:${targets.userId}`
      return 'broadcast'
  }
}

export const broadcastToAll = (event: WebhookEventType, payload: WebhookEventPayload) => {
  if (!io) {
    console.warn('WebSocket not initialized, skipping broadcast')
    return
  }

  console.log(`📡 Broadcasting: ${event}`)
  io.emit(event, {
    timestamp: new Date().toISOString(),
    ...payload,
  })
}
