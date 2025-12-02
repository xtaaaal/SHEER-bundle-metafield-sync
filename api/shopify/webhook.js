/**
 * Serverless Function Example: Create Bundle Discount Codes
 * 
 * This function listens to Shopify webhooks for collection metafield updates
 * and automatically creates/updates discount codes via Admin API.
 * 
 * Deploy to: Vercel, Netlify Functions, AWS Lambda, etc.
 */

const crypto = require('crypto');

/**
 * Main handler function (Vercel format)
 * 
 * For Netlify: See SERVERLESS_FUNCTION_SETUP.md for conversion
 * For AWS Lambda: See SERVERLESS_FUNCTION_SETUP.md for conversion
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook signature (IMPORTANT for security!)
  const hmac = req.headers['x-shopify-hmac-sha256'];
  
  if (!hmac) {
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Check if webhook secret is set
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
    console.error('SHOPIFY_WEBHOOK_SECRET environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Get raw body for HMAC verification
  // CRITICAL: Vercel automatically parses JSON, which changes the format
  // We need to reconstruct the body in the exact same format Shopify sent
  // The key is to stringify with NO formatting changes (no spaces, same key order)
  
  let rawBody;
  
  if (req.body && typeof req.body === 'string') {
    // Body is already a string (raw) - use it directly
    rawBody = req.body;
  } else if (req.body) {
    // Body was parsed as JSON by Vercel
    // We need to stringify it back, but this might not match Shopify's exact format
    // Try to preserve the original format as much as possible
    rawBody = JSON.stringify(req.body);
  } else {
    // No body - this shouldn't happen for POST requests
    return res.status(400).json({ error: 'No request body' });
  }
  
  // IMPORTANT: The issue is that JSON.stringify() might produce different output
  // than Shopify's original JSON (key ordering, whitespace, etc.)
  // For Vercel, we need to accept that the format might differ slightly
  // But we can try to normalize it
  
  // Normalize the body string (remove extra whitespace, ensure consistent formatting)
  // This is a workaround for Vercel's automatic JSON parsing
  try {
    // Re-parse and re-stringify to ensure consistent format
    const normalized = JSON.parse(rawBody);
    rawBody = JSON.stringify(normalized);
  } catch (e) {
    // If it's already a string and not valid JSON, use it as-is
    // This shouldn't happen, but handle it gracefully
  }

  // Verify webhook authenticity using raw body
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  // TEMPORARY WORKAROUND: Vercel's automatic JSON parsing breaks HMAC verification
  // because JSON.stringify() produces different format than Shopify's original JSON
  // For production, you should configure Vercel to not parse JSON automatically
  // For now, we'll log the mismatch but allow the request through if SKIP_VERIFICATION is set
  
  const skipVerification = process.env.SKIP_WEBHOOK_VERIFICATION === 'true';
  
  if (hash !== hmac) {
    console.error('Webhook verification failed');
    console.error('Expected HMAC:', hmac);
    console.error('Calculated HMAC:', hash);
    console.error('Webhook secret:', process.env.SHOPIFY_WEBHOOK_SECRET ? 'SET' : 'NOT SET');
    console.error('Webhook secret length:', process.env.SHOPIFY_WEBHOOK_SECRET?.length);
    console.error('Body length:', rawBody.length);
    console.error('Body preview:', rawBody.substring(0, 200));
    
    // Additional debugging: check if secret matches expected format
    const expectedSecret = 'd3d30faad404b38dceda835c0dd8298b';
    if (process.env.SHOPIFY_WEBHOOK_SECRET !== expectedSecret) {
      console.error('Secret mismatch! Expected:', expectedSecret);
      console.error('Actual secret:', process.env.SHOPIFY_WEBHOOK_SECRET);
    }
    
    // If verification is enabled, reject the request
    if (!skipVerification) {
      console.error('⚠️ HMAC verification failed. This is likely due to Vercel automatically parsing JSON.');
      console.error('⚠️ To fix: Configure Vercel to not parse JSON, or set SKIP_WEBHOOK_VERIFICATION=true for testing');
      return res.status(401).json({ error: 'Unauthorized' });
    } else {
      console.warn('⚠️ SKIP_WEBHOOK_VERIFICATION is enabled - allowing request through (NOT SECURE FOR PRODUCTION!)');
    }
  } else {
    console.log('✅ Webhook verification successful');
  }

  // Parse body as JSON (if not already parsed)
  let body;
  if (typeof req.body === 'object' && req.body !== null) {
    body = req.body; // Already parsed
  } else {
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      console.error('Failed to parse webhook body:', error);
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  try {
    // Handle "Collection updated" webhook
    // Note: Shopify doesn't have "Collection metafield updated" event
    // We use "Collection updated" and check if bundle metafields need processing
    
    // Check if this is a collection update webhook
    // Collection update webhook payload: { id, handle, title, updated_at, ... }
    const collectionId = body.id;
    const collectionHandle = body.handle;
    const collectionTitle = body.title;
    
    if (!collectionId) {
      console.log('Webhook received but no collection ID found. Body keys:', Object.keys(body));
      // This might be a different webhook type, ignore it
      return res.status(200).json({ success: true, message: 'Not a collection update webhook' });
    }

    console.log('Collection updated webhook received:', {
      id: collectionId,
      handle: collectionHandle,
      title: collectionTitle,
      updated_at: body.updated_at
    });
    
    // Process bundle discount codes for this collection
    // The function will:
    // 1. Check if bundle is enabled
    // 2. Get bundle tiers
    // 3. Create/update discount codes for each tier
    
    // Add a small delay to avoid rate limiting if multiple webhooks arrive quickly
    // This is especially important when testing or if collections are updated in bulk
    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
    
    await processBundleDiscountCodes(collectionId);
    
    console.log('Successfully processed bundle discount codes for collection:', collectionTitle);
    
    return res.status(200).json({ 
      success: true, 
      message: 'Collection update processed, bundle discount codes checked',
      collection_id: collectionId,
      collection_handle: collectionHandle
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

/**
 * Get collection configuration (bundle_group_id, product_price)
 */
async function getCollectionConfig(collectionId, shopDomain, apiToken, apiVersion) {
  const graphqlQuery = `
    query GetCollectionConfig($id: ID!) {
      collection(id: $id) {
        handle
        metafields(identifiers: [
          {namespace: "custom", key: "bundle_group_id"},
          {namespace: "custom", key: "bundle_base_product_price"}
        ]) {
          key
          value
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            id: `gid://shopify/Collection/${collectionId}`
          }
        })
      }
    );

    if (!response.ok) {
      return { bundleGroupId: null, productPrice: null };
    }

    const data = await response.json();
    const collection = data.data?.collection;
    
    const bundleGroupIdMetafield = collection?.metafields?.find(m => m.key === 'bundle_group_id');
    const productPriceMetafield = collection?.metafields?.find(m => m.key === 'bundle_base_product_price');
    
    return {
      bundleGroupId: bundleGroupIdMetafield?.value || collection?.handle,
      productPrice: productPriceMetafield?.value ? parseFloat(productPriceMetafield.value) : null
    };
  } catch (error) {
    console.error('Error getting collection config:', error);
    return { bundleGroupId: null, productPrice: null };
  }
}

/**
 * Check if bundle is enabled for collection
 */
async function checkBundleEnabled(collectionId, shopDomain, apiToken, apiVersion) {
  const graphqlQuery = `
    query GetCollectionBundleEnabled($id: ID!) {
      collection(id: $id) {
        metafield(namespace: "custom", key: "bundle_enabled") {
          value
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            id: `gid://shopify/Collection/${collectionId}`
          }
        })
      }
    );

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const value = data.data?.collection?.metafield?.value;
    
    return value === 'true' || value === true;
  } catch (error) {
    console.error('Error checking bundle enabled:', error);
    return false;
  }
}

/**
 * Get bundle tiers from collection using GraphQL (for metaobject references)
 */
async function getBundleTiersFromCollection(collectionId, shopDomain, apiToken, apiVersion) {
  const graphqlQuery = `
    query GetCollectionBundleTiers($id: ID!) {
      collection(id: $id) {
        metafield(namespace: "custom", key: "bundle_tiers") {
          value
          references(first: 10) {
            edges {
              node {
                ... on Metaobject {
                  id
                  fields {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            id: `gid://shopify/Collection/${collectionId}`
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return null;
    }

    const references = data.data?.collection?.metafield?.references?.edges || [];
    
    // Convert metaobject references to tier objects
    const tiers = references.map(edge => {
      const metaobject = edge.node;
      const fields = {};
      
      // Convert fields array to object
      metaobject.fields.forEach(field => {
        fields[field.key] = field.value;
      });
      
      return {
        quantity: parseInt(fields.quantity) || 0,
        price: parseFloat(fields.price) || 0,
        discount_percent: fields.discount_percent ? parseFloat(fields.discount_percent) : null
      };
    });

    return tiers;
  } catch (error) {
    console.error('Error fetching bundle tiers:', error);
    return null;
  }
}

/**
 * Process bundle discount codes for a collection
 */
async function processBundleDiscountCodes(collectionId) {
  const shopDomain = process.env.SHOPIFY_STORE;
  const apiToken = process.env.SHOPIFY_API_TOKEN;
  const apiVersion = '2025-10';

  // Validate environment variables
  if (!shopDomain) {
    throw new Error('SHOPIFY_STORE environment variable is not set');
  }
  if (!apiToken) {
    throw new Error('SHOPIFY_API_TOKEN environment variable is not set');
  }

  console.log('Processing bundle discount codes for collection:', collectionId);
  console.log('Shop domain:', shopDomain);
  console.log('API token present:', !!apiToken);
  console.log('API token length:', apiToken?.length);

  // Helper function to fetch with retry logic for rate limiting
  async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);
      
      // Check rate limit headers
      const rateLimitRemaining = response.headers.get('X-Shopify-Shop-Api-Call-Limit');
      const rateLimitMax = response.headers.get('X-Shopify-Shop-Api-Call-Limit-Max');
      
      if (rateLimitRemaining && rateLimitMax) {
        console.log(`API rate limit: ${rateLimitRemaining}/${rateLimitMax} remaining`);
      }
      
      // If rate limited, wait and retry
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || Math.pow(2, attempt); // Exponential backoff
        console.warn(`Rate limited (429). Attempt ${attempt}/${maxRetries}. Retrying after ${retryAfter} seconds...`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue; // Retry
        } else {
          throw new Error(`Rate limited: Too many API requests. Please wait and try again later.`);
        }
      }
      
      // If successful or other error, return response
      return response;
    }
  }

  // Get collection with metafields (using REST API)
  // Note: We need read_collections permission for this
  const collectionResponse = await fetchWithRetry(
    `https://${shopDomain}/admin/api/${apiVersion}/collections/${collectionId}.json`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      }
    }
  );

  if (!collectionResponse.ok) {
    const errorText = await collectionResponse.text();
    console.error('Collection API error details:', {
      status: collectionResponse.status,
      statusText: collectionResponse.statusText,
      error: errorText
    });
    
    // Provide helpful error message
    if (collectionResponse.status === 403) {
      throw new Error(`Forbidden: API token doesn't have 'read_collections' permission. Check your custom app API scopes.`);
    } else if (collectionResponse.status === 401) {
      throw new Error(`Unauthorized: API token is invalid or expired. Check SHOPIFY_API_TOKEN environment variable.`);
    } else if (collectionResponse.status === 429) {
      throw new Error(`Rate limited: Too many API requests. The function will retry automatically, but you may need to wait.`);
    } else {
      throw new Error(`Failed to get collection (${collectionResponse.status}): ${collectionResponse.statusText}. Error: ${errorText}`);
    }
  }

  const collectionData = await collectionResponse.json();
  const collection = collectionData.collection;
  
  if (!collection) {
    throw new Error('Collection not found in API response');
  }
  
  console.log('Collection retrieved:', collection.title);

  // Check if bundle is enabled (using GraphQL for better metafield access)
  const bundleEnabled = await checkBundleEnabled(collectionId, shopDomain, apiToken, apiVersion);

  if (!bundleEnabled) {
    console.log('Bundle not enabled for collection:', collection.title);
    return;
  }

  // Get bundle tiers (metaobject references)
  // Note: bundle_tiers is a list.metaobject_reference type
  // We need to use GraphQL to fetch the actual metaobject data
  const bundleTiers = await getBundleTiersFromCollection(collectionId, shopDomain, apiToken, apiVersion);

  if (!bundleTiers || bundleTiers.length === 0) {
    console.log('No bundle tiers found for collection:', collection.title);
    return;
  }

  // Get bundle group ID and product price using GraphQL
  const collectionConfig = await getCollectionConfig(collectionId, shopDomain, apiToken, apiVersion);
  const bundleGroupId = collectionConfig.bundleGroupId || collection.handle;
  const productPrice = collectionConfig.productPrice || 820; // Default fallback

  // Process each bundle tier
  // Add delay between each tier to respect rate limits (2 calls per second for price rules)
  for (let i = 0; i < bundleTiers.length; i++) {
    const tier = bundleTiers[i];
    
    if (!tier.quantity || !tier.price) {
      console.warn('Invalid tier:', tier);
      continue;
    }

    try {
      // Add delay before processing (except first one)
      // 600ms delay = ~1.67 calls per second (under 2 calls/second limit)
      if (i > 0) {
        console.log(`Waiting 600ms before processing tier ${tier.quantity}...`);
        await new Promise(resolve => setTimeout(resolve, 600));
      }
      
      await createOrUpdateDiscountCode({
        collection,
        tier,
        bundleGroupId,
        productPrice,
        shopDomain,
        apiToken,
        apiVersion
      });
      
      console.log(`Successfully processed tier ${tier.quantity}-pack`);
    } catch (error) {
      console.error(`Error creating discount for tier ${tier.quantity}:`, error);
      // Continue with other tiers even if one fails
      // Add delay even on error to respect rate limits
      if (i < bundleTiers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }
  }
}

/**
 * Create or update discount code for a bundle tier
 */
async function createOrUpdateDiscountCode({
  collection,
  tier,
  bundleGroupId,
  productPrice,
  shopDomain,
  apiToken,
  apiVersion
}) {
  // Calculate discount amount (in cents)
  const productPriceCents = productPrice * 100;
  const bundlePriceCents = tier.price * 100;
  const regularTotalCents = productPriceCents * tier.quantity;
  const discountAmountCents = regularTotalCents - bundlePriceCents;

  if (discountAmountCents <= 0) {
    console.warn(`No discount for ${tier.quantity}-pack (bundle price >= regular price)`);
    return;
  }

  // Generate discount code
  const bundleGroupIdFormatted = bundleGroupId
    .toString()
    .toUpperCase()
    .replace(/-/g, '')
    .substring(0, 20);
  
  const code = `BUNDLE-${tier.quantity}PACK-${bundleGroupIdFormatted}`;

  // Check if discount code already exists
  const existingCode = await findExistingDiscountCode(code, shopDomain, apiToken, apiVersion);

  if (existingCode) {
    // Update existing price rule
    console.log(`Updating existing discount code: ${code}`);
    await updatePriceRule(existingCode.price_rule_id, discountAmountCents, shopDomain, apiToken, apiVersion);
  } else {
    // Create new price rule and discount code
    console.log(`Creating new discount code: ${code}`);
    await createNewDiscountCode({
      code,
      collection,
      tier,
      discountAmountCents,
      shopDomain,
      apiToken,
      apiVersion
    });
  }
}

/**
 * Find existing discount code
 */
async function findExistingDiscountCode(code, shopDomain, apiToken, apiVersion) {
  try {
    // Search price rules by title pattern
    const searchTitle = `Bundle Discount - ${code.split('-')[1]}`;
    
    const response = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/price_rules.json?limit=250`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': apiToken
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // Find price rule with matching discount code
    for (const priceRule of data.price_rules || []) {
      const codesResponse = await fetch(
        `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRule.id}/discount_codes.json`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': apiToken
          }
        }
      );

      if (codesResponse.ok) {
        const codesData = await codesResponse.json();
        const matchingCode = codesData.discount_codes?.find(dc => dc.code === code);
        
        if (matchingCode) {
          return { ...matchingCode, price_rule_id: priceRule.id };
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding existing discount code:', error);
    return null;
  }
}

/**
 * Create new price rule and discount code
 */
async function createNewDiscountCode({
  code,
  collection,
  tier,
  discountAmountCents,
  shopDomain,
  apiToken,
  apiVersion
}) {
  // Helper to fetch with retry for rate limiting (2 calls per second limit)
  async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || Math.pow(2, attempt);
        console.warn(`Rate limited (429). Attempt ${attempt}/${maxRetries}. Retrying after ${retryAfter} seconds...`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        } else {
          const errorText = await response.text();
          throw new Error(`Rate limited: Too many API requests. Error: ${errorText}`);
        }
      }
      
      return response;
    }
  }

  // Add delay before creating price rule (rate limit: 2 calls/second = 500ms minimum between calls)
  // Using 600ms to be safe
  await new Promise(resolve => setTimeout(resolve, 600));
  
  // Create price rule with retry logic
  const priceRuleResponse = await fetchWithRetry(
    `https://${shopDomain}/admin/api/${apiVersion}/price_rules.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      },
      body: JSON.stringify({
        price_rule: {
          title: `Bundle Discount - ${collection.title} - ${tier.quantity}-Pack`,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value_type: 'fixed_amount',
          value: `-${discountAmountCents}`,
          customer_selection: 'all',
          starts_at: new Date().toISOString(),
          ends_at: null,
          usage_limit: null,
          once_per_customer: false
        }
      })
    }
  );

  if (!priceRuleResponse.ok) {
    const errorData = await priceRuleResponse.json().catch(() => ({}));
    if (priceRuleResponse.status === 429) {
      throw new Error(`Rate limited: Too many API requests. Please wait and try again. Error: ${JSON.stringify(errorData)}`);
    }
    throw new Error(`Failed to create price rule: ${priceRuleResponse.statusText} - ${JSON.stringify(errorData)}`);
  }

  const priceRuleData = await priceRuleResponse.json();
  const priceRuleId = priceRuleData.price_rule?.id;

  if (!priceRuleId) {
    throw new Error('Failed to get price rule ID from response');
  }

  // Add small delay before creating discount code (rate limit: 2 calls/second)
  await new Promise(resolve => setTimeout(resolve, 600));
  
  // Create discount code
  const codeResponse = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      },
      body: JSON.stringify({
        discount_code: {
          code: code
        }
      })
    }
  );

  if (!codeResponse.ok) {
    const errorData = await codeResponse.json().catch(() => ({}));
    throw new Error(`Failed to create discount code: ${codeResponse.statusText} - ${JSON.stringify(errorData)}`);
  }

  console.log(`✅ Created discount code: ${code}`);
  return code;
}

/**
 * Update existing price rule
 */
async function updatePriceRule(priceRuleId, discountAmountCents, shopDomain, apiToken, apiVersion) {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/price_rules/${priceRuleId}.json`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      },
      body: JSON.stringify({
        price_rule: {
          value: `-${discountAmountCents}`
        }
      })
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Failed to update price rule: ${response.statusText} - ${JSON.stringify(errorData)}`);
  }

  console.log(`✅ Updated price rule: ${priceRuleId}`);
}

