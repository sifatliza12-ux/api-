require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Opens/creates backend/data/forgeflow.db and ensures the schema exists —
// every store (User, workflows, My APIs, marketplace, replay runs) is
// SQLite-backed now, not the Map()/arrays this project started with.
// Required here explicitly so DB initialization is visible from the entry
// point, even though the various services would trigger it anyway.
require('./db');

const corsOptions = require('./config/cors');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const marketplaceRoutes = require('./routes/marketplace');
const subscriptionRoutes = require('./routes/subscription');
const myApisRoutes = require('./routes/myApis');
const workflowRoutes = require('./routes/workflows');
const purchaseRequestRoutes = require('./routes/purchaseRequests');
const walletRoutes = require('./routes/wallet');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.JWT_SECRET) {
  console.warn('[Backend] WARNING: JWT_SECRET is not set — auth token signing/verification will fail. Set it in .env.');
}

app.use(cors(corsOptions));
// Default express.json() limit is 100kb — too small for a real recorded
// workflow session (scroll/keydown/input events add up fast). Set generously
// high so longer test recordings don't keep hitting this ceiling.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ message: 'ForgeFlow Backend Running' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'ForgeFlow Backend'
  });
});

app.use('/api/auth', authRoutes);
app.use('/apis', apiRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/api', myApisRoutes);
app.use('/api/workflows', workflowRoutes);

// Manual-approval marketplace purchase workflow (Purchase Requests + Creator
// Wallet). A real payment gateway would later plug in at
// purchaseRequestController.approvePurchaseRequest — that's the single seam
// where "creator clicks Approve" could become "gateway webhook confirms
// payment" without changing anything else in this flow.
app.use('/purchase-requests', purchaseRequestRoutes);
app.use('/wallet', walletRoutes);
app.use('/notifications', notificationRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log('=====================================');
  console.log('🚀 ForgeFlow Backend Started');
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Running on: http://localhost:${PORT}`);
  console.log('=====================================');
});
