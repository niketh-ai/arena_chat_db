const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection - DIRECT CONFIG (no database.js needed)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
});

// Initialize database tables
async function initializeDatabase() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Messages table - FIXED WITH PROPER COLUMNS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_id INTEGER NOT NULL REFERENCES users(id),
        message_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables created successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// ========== API ROUTES ==========

// Health check
app.get('/', (req, res) => {
  res.json({ 
    message: 'Arena Chat Server is running!',
    timestamp: new Date().toISOString()
  });
});

// User Registration
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert user
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, name, email',
      [email, hashedPassword, name]
    );
    
    res.json({ 
      success: true, 
      message: 'User created successfully',
      user: result.rows[0]
    });
    
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ 
        success: false, 
        message: 'Email already exists' 
      });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Registration failed' 
      });
    }
  }
});

// User Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email and password are required' 
      });
    }

    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    const user = result.rows[0];
    
    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid password' 
      });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Login failed' 
    });
  }
});

// Get all users (for friend search)
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email FROM users ORDER BY name'
    );
    
    res.json({ 
      success: true,
      users: result.rows 
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch users' 
    });
  }
});

// Get messages between two users - FIXED QUERY
app.get('/api/messages/:user1Id/:user2Id', async (req, res) => {
  try {
    const { user1Id, user2Id } = req.params;
    
    console.log(`📨 Loading messages between ${user1Id} and ${user2Id}`);
    
    const result = await pool.query(
      `SELECT m.id, m.sender_id as "senderId", m.receiver_id as "receiverId", 
              m.message_text as "messageText", u.name as "senderName", 
              m.created_at as timestamp
       FROM messages m 
       JOIN users u ON m.sender_id = u.id 
       WHERE (m.sender_id = $1 AND m.receiver_id = $2) 
          OR (m.sender_id = $2 AND m.receiver_id = $1) 
       ORDER BY m.created_at ASC`,
      [user1Id, user2Id]
    );
    
    console.log(`✅ Found ${result.rows.length} messages in database`);
    
    res.json({ 
      success: true,
      messages: result.rows 
    });
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch messages' 
    });
  }
});

// ========== REAL-TIME MESSAGING - FIXED VERSION ==========
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Join user's personal room
  socket.on('join_user', (userId) => {
    socket.join(userId.toString());
    console.log(`👤 User ${userId} joined room`);
  });

  // Handle sending messages - COMPLETELY FIXED VERSION
  socket.on('send_message', async (data) => {
    try {
      const { senderId, receiverId, messageText } = data;
      
      console.log('💬 Message received for saving:', { senderId, receiverId, messageText });

      // Validate data
      if (!senderId || !receiverId || !messageText) {
        console.error('❌ Missing required fields');
        socket.emit('message_error', { error: 'Missing required fields' });
        return;
      }

      console.log('💾 Attempting to save message to database...');
      
      // Save message to database - WITH PROPER ERROR HANDLING
      const result = await pool.query(
        'INSERT INTO messages (sender_id, receiver_id, message_text) VALUES ($1, $2, $3) RETURNING id, created_at',
        [senderId, receiverId, messageText]
      );

      const savedMessage = result.rows[0];
      console.log('✅ Message saved to database with ID:', savedMessage.id);
      
      // Get sender name
      const userResult = await pool.query(
        'SELECT name FROM users WHERE id = $1',
        [senderId]
      );
      
      const senderName = userResult.rows[0]?.name || 'Unknown';
      
      const messageData = {
        id: savedMessage.id,
        senderId: parseInt(senderId),
        receiverId: parseInt(receiverId),
        messageText: messageText,
        senderName: senderName,
        timestamp: savedMessage.created_at
      };

      console.log('📨 Broadcasting message:', messageData);

      // Send to receiver
      io.to(receiverId.toString()).emit('new_message', messageData);
      
      // Also send back to sender (for confirmation)
      io.to(senderId.toString()).emit('new_message', messageData);
      
      console.log('✅ Message delivered to both users');

    } catch (error) {
      console.error('❌ Message save error:', error);
      socket.emit('message_error', { error: 'Failed to save message to database' });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
  });
});

// Start server
initializeDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📧 API available at http://localhost:${PORT}/api`);
    console.log(`🔌 WebSocket available at http://localhost:${PORT}`);
  });
}).catch(error => {
  console.error('❌ Failed to start server:', error);
});
