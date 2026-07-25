const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const supabaseAdmin = require('./config/supabaseAdmin');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const transactionsRoutes = require('./routes/transactions');
const housesRoutes = require('./routes/houses');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ service: 'society-app-backend', status: 'running' });
});

app.use('/auth', authRoutes);
app.use('/me', meRoutes);
app.use('/transactions', transactionsRoutes);
app.use('/houses', housesRoutes);

// Confirms the server can reach the linked Supabase project using the
// service-role key. Does not expose the key or any row data in the response.
app.get('/health', async (_req, res) => {
  try {
    const { error, count } = await supabaseAdmin
      .from('societies')
      .select('id', { count: 'exact', head: true });

    if (error) {
      return res.status(503).json({
        status: 'error',
        database: 'unreachable',
        message: error.message,
      });
    }

    res.json({
      status: 'ok',
      database: 'connected',
      societiesCount: count,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(env.port, () => {
  console.log(`society-app-backend listening on http://localhost:${env.port}`);
});
