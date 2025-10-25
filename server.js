const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

// ========== FILE UPLOAD SETUP ==========
// Create uploads directory if it doesn't exist
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('✅ Created uploads directory');
}

// Configure multer for file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'file-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Serve uploaded files statically
app.use('/uploads', express.static('uploads'));

// PostgreSQL connection
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

        // Messages table with media support
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER NOT NULL REFERENCES users(id),
                receiver_id INTEGER NOT NULL REFERENCES users(id),
                message_text TEXT NOT NULL,
                message_type VARCHAR(20) DEFAULT 'text',
                media_url TEXT,
                file_size VARCHAR(50),
                duration VARCHAR(20),
                status VARCHAR(20) DEFAULT 'sent',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create deleted_messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS deleted_messages (
                id SERIAL PRIMARY KEY,
                message_id INTEGER NOT NULL REFERENCES messages(id),
                user_id INTEGER NOT NULL REFERENCES users(id),
                deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, user_id)
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
        timestamp: new Date().toISOString(),
        endpoints: [
            'POST /api/upload - File upload',
            'POST /api/register - User registration',
            'POST /api/login - User login',
            'GET /api/users - Get all users',
            'GET /api/messages/:user1Id/:user2Id - Get messages',
            'DELETE /api/messages/delete-for-me - Delete message for me',
            'DELETE /api/messages/delete-for-everyone - Delete message for everyone'
        ]
    });
});

// FILE UPLOAD ENDPOINT - FIXED POST METHOD
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        console.log('📁 Upload request received');
        
        if (!req.file) {
            console.log('❌ No file in request');
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            });
        }

        console.log('✅ File received:', {
            originalname: req.file.originalname,
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype
        });
        
        // Use your actual Render URL
        const fileUrl = `https://arena-chat-db.onrender.com/uploads/${req.file.filename}`;
        
        console.log('📤 File URL generated:', fileUrl);
        
        res.json({
            success: true,
            message: 'File uploaded successfully',
            fileUrl: fileUrl,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            fileType: req.file.mimetype
        });
        
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Upload failed: ' + error.message 
        });
    }
});

// Test upload endpoint with GET (for debugging)
app.get('/api/upload', (req, res) => {
    res.json({ 
        message: 'Use POST method to upload files',
        example: 'curl -X POST -F "file=@yourfile.jpg" https://arena-chat-db.onrender.com/api/upload'
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

        const hashedPassword = await bcrypt.hash(password, 10);
        
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
        if (error.code === '23505') {
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

// Get all users
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

// Get messages between two users
app.get('/api/messages/:user1Id/:user2Id', async (req, res) => {
    try {
        const { user1Id, user2Id } = req.params;
        
        const result = await pool.query(
            `SELECT m.id, m.sender_id as "senderId", m.receiver_id as "receiverId", 
                    m.message_text as "messageText", u.name as "senderName", 
                    m.message_type as "messageType", m.media_url as "mediaUrl",
                    m.file_size as "fileSize", m.duration, m.status,
                    m.created_at as timestamp
            FROM messages m 
            JOIN users u ON m.sender_id = u.id 
            WHERE ((m.sender_id = $1 AND m.receiver_id = $2) 
                OR (m.sender_id = $2 AND m.receiver_id = $1))
                AND m.id NOT IN (
                SELECT message_id FROM deleted_messages WHERE user_id = $1
                )
            ORDER BY m.created_at ASC`,
            [user1Id, user2Id]
        );
        
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

// Delete message for me only
app.delete('/api/messages/delete-for-me', async (req, res) => {
    try {
        const { messageId, userId } = req.body;
        
        const messageCheck = await pool.query(
            'SELECT * FROM messages WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2)',
            [messageId, userId]
        );
        
        if (messageCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found or no permission to delete'
            });
        }
        
        await pool.query(
            'INSERT INTO deleted_messages (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [messageId, userId]
        );
        
        res.json({
            success: true,
            message: 'Message deleted for you'
        });
        
    } catch (error) {
        console.error('❌ Delete for me error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete message'
        });
    }
});

// Delete message for everyone
app.delete('/api/messages/delete-for-everyone', async (req, res) => {
    try {
        const { messageId, userId } = req.body;
        
        const messageCheck = await pool.query(
            'SELECT * FROM messages WHERE id = $1 AND sender_id = $2',
            [messageId, userId]
        );
        
        if (messageCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'Only message sender can delete for everyone'
            });
        }
        
        const messageDetails = await pool.query(
            `SELECT m.*, u.name as sender_name 
            FROM messages m 
            JOIN users u ON m.sender_id = u.id 
            WHERE m.id = $1`,
            [messageId]
        );
        
        await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
        await pool.query('DELETE FROM deleted_messages WHERE message_id = $1', [messageId]);
        
        const message = messageDetails.rows[0];
        if (message) {
            io.to(message.sender_id.toString()).emit('message_deleted', messageId);
            io.to(message.receiver_id.toString()).emit('message_deleted', messageId);
        }
        
        res.json({
            success: true,
            message: 'Message deleted for everyone'
        });
        
    } catch (error) {
        console.error('❌ Delete for everyone error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete message'
        });
    }
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
    console.log('🔌 User connected:', socket.id);

    socket.on('join_user', (userId) => {
        socket.join(userId.toString());
        console.log(`👤 User ${userId} joined room`);
    });

    socket.on('send_message', async (data) => {
        try {
            const { senderId, receiverId, messageText, messageType = 'text', mediaUrl, fileSize, duration } = data;
            
            console.log('💬 Message received:', { senderId, receiverId, messageType });

            if (!senderId || !receiverId || !messageText) {
                socket.emit('message_error', { error: 'Missing required fields' });
                return;
            }

            const result = await pool.query(
                `INSERT INTO messages (sender_id, receiver_id, message_text, message_type, media_url, file_size, duration) 
                VALUES ($1, $2, $3, $4, $5, $6, $7) 
                RETURNING id, created_at`,
                [senderId, receiverId, messageText, messageType, mediaUrl, fileSize, duration]
            );

            const savedMessage = result.rows[0];
            
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
                timestamp: savedMessage.created_at,
                messageType: messageType,
                mediaUrl: mediaUrl,
                fileSize: fileSize,
                duration: duration,
                status: 'sent'
            };

            io.to(receiverId.toString()).emit('new_message', messageData);
            io.to(senderId.toString()).emit('new_message', messageData);
            
            console.log('✅ Message delivered to both users');

        } catch (error) {
            console.error('❌ Message save error:', error);
            socket.emit('message_error', { error: 'Failed to save message' });
        }
    });

    socket.on('user_typing', (data) => {
        const { userId, isTyping, chatWithUserId } = data;
        io.to(chatWithUserId.toString()).emit('user_typing', {
            userId: userId,
            isTyping: isTyping,
            chatWithUserId: chatWithUserId
        });
    });

    socket.on('user_online', (data) => {
        const { userId, isOnline } = data;
        io.emit('user_online', {
            userId: userId,
            isOnline: isOnline,
            lastSeen: new Date().toLocaleTimeString()
        });
    });

    socket.on('message_status_update', (data) => {
        const { messageId, status, userId } = data;
        pool.query(
            'UPDATE messages SET status = $1 WHERE id = $2',
            [status, messageId]
        );
        io.to(userId.toString()).emit('message_status_update', {
            messageId: messageId,
            status: status
        });
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
        console.log(`📧 API available at https://arena-chat-db.onrender.com/api`);
        console.log(`🔌 WebSocket available at https://arena-chat-db.onrender.com`);
        console.log('📁 File upload system: ACTIVE');
        console.log('📤 Upload endpoint: POST https://arena-chat-db.onrender.com/api/upload');
    });
}).catch(error => {
    console.error('❌ Failed to start server:', error);
});
