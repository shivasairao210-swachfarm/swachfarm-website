/**
 * Swach Farm - Serverless API
 * -----------------------------------------------------------------------
 * A self-contained Express application, wrapped with serverless-http, that
 * powers the Farm Shop + Agritourism backend for Swach Farm.
 *
 * Routes exposed (all mounted under /api, see netlify.toml for the redirect
 * that forwards /api/* traffic to this function):
 *
 *   POST /api/auth/register    - create a new customer account
 *   POST /api/auth/login       - authenticate and receive a JWT
 *   GET  /api/dashboard/data   - fetch the logged-in user's profile + logs
 *   POST /api/action           - record a shop order or a tour booking
 *   GET  /api/health           - simple health check
 *
 * Deployment notes:
 *   - Set the MONGO_URI environment variable in the Netlify dashboard
 *     (Site settings -> Environment variables) to your MongoDB Atlas
 *     connection string.
 *   - Set the JWT_SECRET environment variable to a long, random string.
 * -----------------------------------------------------------------------
 */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const serverless = require('serverless-http');

// -------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------

const MONGO_URI = process.env.MONGO_URI || '';
const JWT_SECRET = process.env.JWT_SECRET || 'swach-farm-dev-secret-change-me-in-production';
const JWT_EXPIRES_IN = '2h';
const SALT_ROUNDS = 10;
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const NOTIFY_SENDER_EMAIL = process.env.NOTIFY_SENDER_EMAIL || NOTIFY_EMAIL;

if (!process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    '[swach-farm-api] WARNING: JWT_SECRET environment variable is not set. ' +
      'Using an insecure development fallback secret. Set JWT_SECRET in your ' +
      'Netlify environment variables before going live.'
  );
}

// -------------------------------------------------------------------------
// MongoDB connection caching for serverless execution
// -------------------------------------------------------------------------
// Serverless functions can be re-invoked on a "warm" container that still
// holds a live connection from a previous invocation. Re-connecting on
// every single request would exhaust connection pools and slow things
// down, so we cache the connection promise on the module scope (which
// persists across warm invocations) and reuse it whenever possible.

let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  if (!MONGO_URI) {
    throw new Error(
      'MONGO_URI environment variable is not set. Please configure it in your ' +
        'Netlify site environment variables so the API can reach MongoDB.'
    );
  }

  mongoose.set('strictQuery', true);

  cachedConnection = await mongoose.connect(MONGO_URI, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 8000,
  });

  return cachedConnection;
}

// -------------------------------------------------------------------------
// Mongoose Schemas / Models
// -------------------------------------------------------------------------

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
    },
    points: {
      type: Number,
      default: 0,
    },
    activityLog: {
      type: [String],
      default: [],
    },
    cart: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Guard against Mongoose re-registering the model on warm serverless
// invocations, which would otherwise throw "OverwriteModelError".
const User = mongoose.models.User || mongoose.model('User', userSchema);

const inquirySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['contact', 'shop', 'tour'],
    },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    service: { type: String, trim: true },
    message: { type: String, trim: true },
    description: { type: String, trim: true },
    status: {
      type: String,
      enum: ['new', 'contacted', 'resolved'],
      default: 'new',
    },
  },
  { timestamps: true }
);

const Inquiry = mongoose.models.Inquiry || mongoose.model('Inquiry', inquirySchema);

// -------------------------------------------------------------------------
// Email notifications (Brevo)
// -------------------------------------------------------------------------
// Best-effort: a failure here must never block or fail an inquiry submission,
// since the inquiry is already safely saved to MongoDB by that point.

const INQUIRY_TYPE_LABELS = {
  contact: 'Contact Form Inquiry',
  shop: 'Guest Farm Shop Order',
  tour: 'Guest Farm Tour Booking',
};

async function sendInquiryNotificationEmail(inquiry) {
  if (!BREVO_API_KEY || !NOTIFY_EMAIL) {
    // eslint-disable-next-line no-console
    console.warn('[swach-farm-api] Skipping email notification: BREVO_API_KEY or NOTIFY_EMAIL not configured.');
    return;
  }

  const rows = [
    ['Type', INQUIRY_TYPE_LABELS[inquiry.type] || inquiry.type],
    ['Name', inquiry.name],
    ['Phone', inquiry.phone],
    inquiry.email ? ['Email', inquiry.email] : null,
    inquiry.address ? ['Address', inquiry.address] : null,
    inquiry.service ? ['Service', inquiry.service] : null,
    inquiry.description ? ['Details', inquiry.description] : null,
    inquiry.message ? ['Message', inquiry.message] : null,
  ].filter(Boolean);

  const htmlRows = rows
    .map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>${label}</strong></td><td style="padding:4px 0;">${value}</td></tr>`)
    .join('');

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: 'Swach Farm Website', email: NOTIFY_SENDER_EMAIL },
        to: [{ email: NOTIFY_EMAIL }],
        subject: `New ${INQUIRY_TYPE_LABELS[inquiry.type] || inquiry.type} from ${inquiry.name}`,
        htmlContent: `<table cellpadding="0" cellspacing="0">${htmlRows}</table>`,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // eslint-disable-next-line no-console
      console.error('[swach-farm-api] Brevo email send failed:', response.status, body);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Brevo email send error:', err.message);
  }
}

// -------------------------------------------------------------------------
// Express app setup
// -------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json());

// Normalize incoming request paths so routes match regardless of whether
// the request arrives via the "/api/*" Netlify redirect (which preserves
// the original "/api/..." path) or hits the raw function URL directly at
// "/.netlify/functions/api/...".
app.use((req, res, next) => {
  if (req.url.startsWith('/.netlify/functions/api')) {
    req.url = req.url.replace('/.netlify/functions/api', '/api') || '/api';
  }
  next();
});

// Ensure a database connection is available before handling any request
// that needs one. If the connection fails (e.g. missing/incorrect
// MONGO_URI) we respond with a clear 503 instead of a generic crash so the
// frontend can show a friendly "server isn't live yet" message.
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Database connection error:', err.message);
    res.status(503).json({
      success: false,
      message:
        'The Swach Farm server database is not reachable right now. Please try again shortly.',
    });
  }
});

// -------------------------------------------------------------------------
// Auth middleware
// -------------------------------------------------------------------------

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'No authorization token provided. Please log in again.',
    });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Malformed authorization header.',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Your session has expired or is invalid. Please log in again.',
    });
  }
}

// -------------------------------------------------------------------------
// Health check
// -------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Swach Farm API is up and running.',
    timestamp: new Date().toISOString(),
  });
});

// -------------------------------------------------------------------------
// Inquiries (public) - contact form submissions, and guest shop orders /
// tour bookings placed by visitors without an account.
// -------------------------------------------------------------------------

app.post('/api/inquiries', async (req, res) => {
  try {
    const { type, name, phone, email, address, service, message, description } = req.body || {};

    if (!['contact', 'shop', 'tour'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Inquiry type must be "contact", "shop" or "tour".',
      });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }

    const inquiry = await Inquiry.create({
      type,
      name: name.trim(),
      phone: phone.trim(),
      email: email ? email.trim().toLowerCase() : undefined,
      address: address ? address.trim() : undefined,
      service: service ? service.trim() : undefined,
      message: message ? message.trim() : undefined,
      description: description ? description.trim() : undefined,
    });

    await sendInquiryNotificationEmail(inquiry);

    return res.status(201).json({
      success: true,
      message: 'Thank you! Your request has been received. Our team will contact you shortly.',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Inquiry error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while submitting your request. Please try again.',
    });
  }
});

// -------------------------------------------------------------------------
// Auth routes
// -------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required and must be at least 6 characters long.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email address already exists. Please log in instead.',
      });
    }

    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      points: 0,
      activityLog: [
        `Welcome to Swach Farm, ${name.trim()}! Your account was created on ${new Date().toLocaleDateString()}.`,
      ],
    });

    await newUser.save();

    const tokenPayload = {
      id: newUser._id.toString(),
      name: newUser.name,
      email: newUser.email,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully. Welcome to the Swach Farm family!',
      token,
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        points: newUser.points,
        cart: newUser.cart,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Register error:', err);

    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email address already exists. Please log in instead.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Something went wrong while creating your account. Please try again.',
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Both email and password are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const tokenPayload = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(200).json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        points: user.points,
        cart: user.cart,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Login error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while logging you in. Please try again.',
    });
  }
});

// -------------------------------------------------------------------------
// Dashboard route (protected)
// -------------------------------------------------------------------------

app.get('/api/dashboard/data', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User account could not be found.',
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        points: user.points,
        activityLog: user.activityLog,
        memberSince: user.createdAt,
        cart: user.cart,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Dashboard data error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while loading your dashboard. Please try again.',
    });
  }
});

// -------------------------------------------------------------------------
// Cart route (protected) - persists a user's cart to their account so it
// follows them across logout/login and devices.
// -------------------------------------------------------------------------

app.put('/api/cart', verifyToken, async (req, res) => {
  try {
    const { cart } = req.body || {};

    if (cart !== null && typeof cart !== 'undefined' && (typeof cart !== 'object' || Array.isArray(cart))) {
      return res.status(400).json({ success: false, message: 'Cart must be an object.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User account could not be found.',
      });
    }

    user.cart = cart || {};
    await user.save();

    return res.status(200).json({ success: true, cart: user.cart });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Cart save error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while saving your cart. Please try again.',
    });
  }
});

// -------------------------------------------------------------------------
// Action route (protected) - shop orders + tour bookings
// -------------------------------------------------------------------------

app.post('/api/action', verifyToken, async (req, res) => {
  try {
    const { type, description } = req.body || {};

    if (!type || (type !== 'shop' && type !== 'tour')) {
      return res.status(400).json({
        success: false,
        message: 'Action type must be either "shop" or "tour".',
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User account could not be found.',
      });
    }

    const timestamp = new Date().toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    let pointsEarned = 0;
    let logEntry = '';

    if (type === 'shop') {
      pointsEarned = 15;
      logEntry = `[${timestamp}] Farm Shop Order placed${
        description ? ' - ' + description : ''
      } (+${pointsEarned} points)`;
    } else if (type === 'tour') {
      pointsEarned = 10;
      logEntry = `[${timestamp}] Farm Tour booked${
        description ? ' - ' + description : ''
      } (+${pointsEarned} points)`;
    }

    user.points += pointsEarned;
    user.activityLog.push(logEntry);

    await user.save();

    await sendInquiryNotificationEmail({
      type,
      name: user.name,
      phone: 'N/A (logged-in account, no phone on file)',
      email: user.email,
      description,
    });

    return res.status(200).json({
      success: true,
      message:
        type === 'shop'
          ? 'Your pickup order has been recorded. See you at the farm!'
          : 'Your farm tour has been booked. We look forward to hosting you!',
      pointsEarned,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        points: user.points,
        activityLog: user.activityLog,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[swach-farm-api] Action error:', err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while recording your action. Please try again.',
    });
  }
});

// -------------------------------------------------------------------------
// Fallback 404 handler for unmatched API routes
// -------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `No API route found for ${req.method} ${req.originalUrl}`,
  });
});

// -------------------------------------------------------------------------
// Export as a Netlify Function via serverless-http
// -------------------------------------------------------------------------

module.exports.handler = serverless(app);
module.exports.app = app;
