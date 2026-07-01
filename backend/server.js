require('dotenv').config();

const express = require('express');
const cors = require('cors');

const apiRoutes = require('./routes/api');
const marketplaceRoutes = require('./routes/marketplace');
const subscriptionRoutes = require('./routes/subscription');
const authRoutes = require('./routes/auth');

const app = express();
const port = process.env.PORT || 5000;
const nodeEnv = process.env.NODE_ENV || 'development';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ message: 'ForgeFlow Backend Running' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'ForgeFlow Backend'
  });
});

app.use('/apis', apiRoutes);
app.use('/marketplace', marketplaceRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/auth', authRoutes);

app.listen(port, () => {
  console.log('=====================================');
  console.log('🚀 ForgeFlow Backend Started');
  console.log(`Environment: ${nodeEnv}`);
  console.log(`Running on: http://localhost:${port}`);
  console.log('=====================================');
});
