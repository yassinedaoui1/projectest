const express = require('express');
const socketIo = require('socket.io');
const amqp = require('amqplib');
const redis = require('redis');

const RABBITMQ_URL = 'amqp://admin:admin123@rabbitmq';
const REDIS_URL = 'redis://redis';
const PORT = 3000;
const RETRY_DELAY = 5000; 

const app = express();
app.use(express.json());
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const io = socketIo(server);

async function createRedisClient() {
  const client = redis.createClient({ url: REDIS_URL });

  client.on('error', (err) => {
    console.error('Redis connection error:', err);
  });

  try {
    await client.connect();
    console.log('Redis connected successfully');
    return client;
  } catch (err) {
    console.error('Initial Redis connection failed, retrying...');
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    return createRedisClient();
  }
}

let redisClient = createRedisClient();

async function createRabbitMQConnection() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    console.log('RabbitMQ connected successfully');
    
    conn.on('error', (err) => {
      console.error('RabbitMQ connection error:', err);
      setTimeout(() => createRabbitMQConnection(), RETRY_DELAY);
    });
    
    conn.on('close', () => {
      console.log('RabbitMQ connection closed, reconnecting...');
      setTimeout(() => createRabbitMQConnection(), RETRY_DELAY);
    });

    return conn;
  } catch (err) {
    console.error('Initial RabbitMQ connection failed, retrying...');
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    return createRabbitMQConnection();
  }
}

let rabbitMQConnection = createRabbitMQConnection();

app.post('/event', async (req, res) => {
  const event = req.body;
  
  try {
    const conn = await rabbitMQConnection;
    const channel = await conn.createChannel();
    await channel.assertQueue('notifications', { durable: true });
    channel.sendToQueue('notifications', Buffer.from(JSON.stringify(event)));
    res.status(202).json({ message: 'Event queued' });
  } catch (err) {
    console.error('Failed to queue event:', err);
    res.status(500).json({ error: 'Failed to queue event' });
  }
});

async function startWorker() {
  try {
    const conn = await rabbitMQConnection;
    const channel = await conn.createChannel();
    await channel.assertQueue('notifications', { durable: true });
    
    channel.consume('notifications', async (msg) => {
      if (msg) {
        try {
          const event = JSON.parse(msg.content.toString());
          console.log('Processing event:', event);
          
          io.to(`user_${event.userId}`).emit('notification', event);
          
          await (await redisClient).setEx(
            `notif:${event.userId}:${Date.now()}`,
            60 * 60 * 24 * 7,
            JSON.stringify(event)
          );
          
          channel.ack(msg);
        } catch (err) {
          console.error('Error processing message:', err);
          channel.nack(msg);
        }
      }
    });
    
    console.log('Worker started successfully');
  } catch (err) {
    console.error('Worker initialization failed, retrying...', err);
    setTimeout(startWorker, RETRY_DELAY);
  }
}

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  if (userId) {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} connected`);
    
    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
    });
  }
});

Promise.all([redisClient, rabbitMQConnection])
  .then(() => {
    startWorker();
    console.log('Notification service fully initialized');
  })
  .catch(err => {
    console.error('Initialization failed:', err);
  });

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  
  try {
    const client = await redisClient;
    await client.quit();
    console.log('Redis connection closed');
  } catch (err) {
    console.error('Error closing Redis:', err);
  }
  
  try {
    const conn = await rabbitMQConnection;
    await conn.close();
    console.log('RabbitMQ connection closed');
  } catch (err) {
    console.error('Error closing RabbitMQ:', err);
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});