'use strict'

require('dotenv').config()
const path = require('path')
const Redis = require('ioredis')
const fastify = require('fastify')
const fastifyStatic = require('fastify-static')
const fastifyRateLimit = require('fastify-rate-limit')
const { FastifySSEPlugin } = require('fastify-sse-v2')
const { EventEmitter } = require('events')
const { EventIterator } = require('event-iterator')

const PORT = process.env.PORT || 8080
const REDIS_URL = process.env.REDIS_URL
const RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || 100
const RATE_LIMIT_WINDOW = process.env.RATE_LIMIT_WINDOW || '1 minute'

const cache = new Redis(REDIS_URL)
const pub = new Redis(REDIS_URL)
const sub = new Redis(REDIS_URL)
const events = new EventEmitter()

const server = fastify({
  trustProxy: true,
  logger: {
    prettyPrint: true
  }
})
server.register(fastifyRateLimit, {
  global: false,
  redis: cache
})
server.register(fastifyStatic, {
  root: path.join(__dirname, 'public')
})
server.register(FastifySSEPlugin)

// Register to an Event by id
server.get('/events/feedback/:id', (request, reply) => {
  const id = request.params.id
  const eventIterator = new EventIterator(({ push }) => {
    server.log.info(`Listening for feedback events, id: ${id}`)
    const hb = heartbeat(id)
    events.on(`feedback:${id}`, push)
    events.on(`heartbeat:${id}`, push)
    return () => {
      server.log.info(`Cleaning up timers and events for id: ${id}`)
      events.removeEventListener(`feedback:${id}`)
      events.removeEventListener(`heartbeat:${id}`)
      clearInterval(hb)
    }
  })
  reply.sse(eventIterator)
})

// Send a feedback event by id
// body: {"feedback": "keyword"}
server.post('/api/feedback/:id', {
  config: {
    rateLimit: {
      max: RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_WINDOW
    }
  }
}, (request, reply) => {
  const id = request.params.id
  const feedback = request.body.feedback
  const message = {
    event: `feedback:${id}`,
    data: {
      id,
      event: 'feedback',
      data: feedback
    }
  }
  pub.publish('feedback', JSON.stringify(message))
  reply.send({ message: 'feedback received' })
})

function heartbeat (id) {
  server.log.info(`Starting heartbeat for id: ${id}`)
  return setInterval(() => {
    events.emit(`heartbeat:${id}`, { id, event: 'heartbeat', data: 'ping' })
  }, 30 * 1000)
}

async function start () {
  const address = await server.listen(PORT, '0.0.0.0')

  await sub.subscribe('feedback')
  sub.on('message', (channel, message) => {
    if (channel === 'feedback') {
      try {
        const { event, data } = JSON.parse(message)
        events.emit(event, data)
      } catch (err) {
        server.info.error(err)
      }
    }
  })

  server.log.info(`Server listening on ${address}`)
}

start().catch(err => {
  server.log.error(err)
  process.exit(1)
})
