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

  // Vercel automatically parses JSON, so we need to reconstruct the body
  // Use JSON.stringify with no formatting to match Shopify's exact format
  // This is critical - any difference in formatting will cause HMAC mismatch
  const rawBody = JSON.stringify(req.body);

  // Verify webhook authenticity using raw body
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

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
    
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Use parsed body (already available from req.body)
  const body = req.body;

  try {
    // Handle collection metafield update
    const metafield = body.metafield;
    
    if (!metafield) {
      return res.status(400).json({ error: 'No metafield in webhook' });
    }

    // Check if it's a bundle-related metafield
    if (metafield.namespace === 'custom' && 
        (metafield.key === 'bundle_tiers' || metafield.key === 'bundle_enabled')) {
      
      console.log('Bundle metafield updated:', metafield.key);
      
      // Get collection ID from metafield owner
      const collectionId = metafield.owner_id;
      
      // Process bundle discount codes
      await processBundleDiscountCodes(collectionId);
      
      return res.status(200).json({ 
        success: true, 
        message: 'Bundle discount codes processed' 
      });
    }

    // Not a bundle metafield, ignore
    return res.status(200).json({ success: true, message: 'Ignored' });

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

  // Get collection with metafields
  const collectionResponse = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/collections/${collectionId}.json`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': apiToken
      }
    }
  );

  if (!collectionResponse.ok) {
    throw new Error(`Failed to get collection: ${collectionResponse.statusText}`);
  }

  const collectionData = await collectionResponse.json();
  const collection = collectionData.collection;

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
  for (const tier of bundleTiers) {
    if (!tier.quantity || !tier.price) {
      console.warn('Invalid tier:', tier);
      continue;
    }

    try {
      await createOrUpdateDiscountCode({
        collection,
        tier,
        bundleGroupId,
        productPrice,
        shopDomain,
        apiToken,
        apiVersion
      });
    } catch (error) {
      console.error(`Error creating discount for tier ${tier.quantity}:`, error);
      // Continue with other tiers even if one fails
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
  // Create price rule
  const priceRuleResponse = await fetch(
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
    throw new Error(`Failed to create price rule: ${priceRuleResponse.statusText} - ${JSON.stringify(errorData)}`);
  }

  const priceRuleData = await priceRuleResponse.json();
  const priceRuleId = priceRuleData.price_rule?.id;

  if (!priceRuleId) {
    throw new Error('Failed to get price rule ID from response');
  }

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

