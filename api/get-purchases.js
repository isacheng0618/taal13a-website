import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function isEmail(value) {
  return typeof value === 'string' && value.includes('@') && value.includes('.');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const email = req.query.email;

    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Missing email.' });
    }

    const { data: purchases, error: purchaseError } = await supabase
      .from('purchases')
      .select(`
        id,
        product_id,
        created_at,
        products (
          id,
          title_zh,
          title_nl,
          title_en,
          type,
          product_type
        )
      `)
      .eq('email', email)
      .order('created_at', { ascending: false });

    if (purchaseError) throw purchaseError;

    const { data: coursePurchases, error: courseError } = await supabase
      .from('course_purchases')
      .select(`
        id,
        course_id,
        created_at
      `)
      .eq('email', email)
      .order('created_at', { ascending: false });

    if (courseError) throw courseError;

    return res.status(200).json({
      purchases: purchases || [],
      coursePurchases: coursePurchases || []
    });

  } catch (error) {
    console.error('get-purchases error:', error);
    return res.status(500).json({ error: 'Could not load purchases.' });
  }
}
