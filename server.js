const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AMAZON_AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Browser-like headers
function getHeaders() {
    return {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    };
}

function extractASIN(url) {
    if (!url) return null;

    const patterns = [
        /\/dp\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/gp\/product\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/product\/([A-Z0-9]{10})(?:[/?&]|$)/i,
        /\/ASIN\/([A-Z0-9]{10})(?:[/?&]|$)/i
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1].toUpperCase();
    }

    return null;
}

async function fetchViaJina(url) {
    try {
        const response = await axios.get(`https://r.jina.ai/${url}`, {
            headers: {
                Accept: 'application/json',
                'X-Return-Format': 'markdown'
            },
            timeout: 15000
        });

        const responseData = response.data?.data || response.data || {};
        const markdownContent = responseData.content || '';
        const title = responseData.title || '';

        let price = '';
        const priceMatch = markdownContent.match(
            /(?:₹|INR|\bRs\.?)\s*([0-9,]+)/i
        );

        if (priceMatch && priceMatch[1]) {
            price = priceMatch[1].replace(/,/g, '');
        }

        return { title, price, image: '' };
    } catch (error) {
        console.error('Jina fallback error:', error.message);
        return null;
    }
}

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/extract-product', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid URL provided.'
        });
    }

    try {
        let finalUrl = rawUrl;
        let response = null;

        try {
            response = await axios.get(rawUrl, {
                headers: getHeaders(),
                timeout: 20000,
                maxRedirects: 10,
                validateStatus: () => true
            });

            if (
                response.request &&
                response.request.res &&
                response.request.res.responseUrl
            ) {
                finalUrl = response.request.res.responseUrl;
            }
        } catch (error) {
            console.error('Initial URL fetch error:', error.message);

            if (
                error.request &&
                error.request.res &&
                error.request.res.responseUrl
            ) {
                finalUrl = error.request.res.responseUrl;
            } else {
                throw new Error(
                    'Unable to reach the provided URL. The website may be blocking the request.'
                );
            }
        }

        const lowerUrl = finalUrl.toLowerCase();
        const isAmazon =
            lowerUrl.includes('amazon.') ||
            lowerUrl.includes('amzn.');
        const isMeesho = lowerUrl.includes('meesho.com');

        if (!isAmazon && !isMeesho) {
            return res.status(400).json({
                success: false,
                error: 'Only Amazon and Meesho URLs are supported.'
            });
        }

        const extractedData = {
            title: '',
            price: '',
            image: '',
            finalUrl,
            asin: null,
            affiliateUrl: finalUrl
        };

        if (
            response &&
            typeof response.data === 'string' &&
            response.data.length > 0
        ) {
            const $ = cheerio.load(response.data);

            const pageTitle = $('title').text().trim().toLowerCase();

            const isAmazonBotPage =
                pageTitle.includes('robot check') ||
                pageTitle.includes('captcha') ||
                pageTitle.includes('sorry') ||
                $('form[action="/errors/validateCaptcha"]').length > 0;

            if (isAmazon) {
                if (isAmazonBotPage) {
                    console.log('Amazon bot page detected. Trying Jina...');

                    const jinaData = await fetchViaJina(finalUrl);

                    if (jinaData) {
                        extractedData.title = jinaData.title || '';
                        extractedData.price = jinaData.price || '';
                        extractedData.image = jinaData.image || '';
                    }
                } else {
                    extractedData.title =
                        $('#productTitle').text().trim() ||
                        $('meta[property="og:title"]').attr('content') ||
                        $('h1').first().text().trim() ||
                        '';

                    const priceText =
                        $('.a-price-whole').first().text().trim() ||
                        $('#priceblock_ourprice').first().text().trim() ||
                        $('#priceblock_dealprice').first().text().trim() ||
                        $('.a-color-price').first().text().trim() ||
                        '';

                    extractedData.price = priceText.replace(/[^\d]/g, '');

                    const dynamicImgStr =
                        $('#landingImage').attr('data-a-dynamic-image') ||
                        $('#imgBlkFront').attr('data-a-dynamic-image') ||
                        '';

                    if (dynamicImgStr) {
                        try {
                            const images = JSON.parse(dynamicImgStr);
                            const imageUrls = Object.keys(images);

                            if (imageUrls.length > 0) {
                                extractedData.image = imageUrls[0];
                            }
                        } catch (error) {
                            console.log('Dynamic image JSON parse failed.');
                        }
                    }

                    if (!extractedData.image) {
                        extractedData.image =
                            $('meta[property="og:image"]').attr('content') ||
                            $('meta[property="og:image:secure_url"]').attr('content') ||
                            '';
                    }
                }
            } else if (isMeesho) {
                extractedData.title =
                    $('meta[property="og:title"]').attr('content') ||
                    $('h1').first().text().trim() ||
                    '';

                extractedData.image =
                    $('meta[property="og:image"]').attr('content') || '';

                const ldScripts = $('script[type="application/ld+json"]');

                ldScripts.each((index, element) => {
                    if (extractedData.price) return;

                    const text = $(element).html();
                    if (!text) return;

                    try {
                        const json = JSON.parse(text);

                        const findPrice = (obj) => {
                            if (!obj || typeof obj !== 'object') return null;

                            if (obj.offers && obj.offers.price) {
                                return obj.offers.price;
                            }

                            if (obj.price) return obj.price;

                            for (const key of Object.keys(obj)) {
                                const result = findPrice(obj[key]);
                                if (result !== null) return result;
                            }

                            return null;
                        };

                        const foundPrice = findPrice(json);

                        if (foundPrice) {
                            extractedData.price = String(foundPrice).replace(
                                /[^\d.]/g,
                                ''
                            );
                        }
                    } catch (error) {
                        // Ignore invalid JSON-LD
                    }
                });

                if (!extractedData.price) {
                    const bodyText = $('body').text();
                    const priceMatch = bodyText.match(
                        /(?:₹|INR)\s*([0-9,]+)/i
                    );

                    if (priceMatch) {
                        extractedData.price = priceMatch[1].replace(/,/g, '');
                    }
                }
            }
        }

        if (isAmazon) {
            extractedData.asin = extractASIN(finalUrl);

            if (extractedData.asin) {
                const tag = AMAZON_AFFILIATE_TAG.trim();
                const tagString = tag
                    ? `?tag=${encodeURIComponent(tag)}`
                    : '';

                extractedData.affiliateUrl =
                    `https://www.amazon.in/dp/${extractedData.asin}${tagString}`;

                if (!extractedData.image) {
                    extractedData.image =
                        `https://images-na.ssl-images-amazon.com/images/P/${extractedData.asin}.01._SCLZZZZZZZ_SX900_.jpg`;
                }
            }
        }

        if (extractedData.price) {
            const numericPrice = parseFloat(
                String(extractedData.price).replace(/[^\d.]/g, '')
            );

            if (Number.isFinite(numericPrice) && numericPrice > 20) {
                extractedData.price = `₹${Math.round(numericPrice)}`;
            } else {
                extractedData.price = '';
            }
        }

        if (
            !extractedData.title &&
            !extractedData.image &&
            !extractedData.price
        ) {
            return res.status(422).json({
                success: false,
                error:
                    'Product details could not be extracted. The website may be blocking automated access.',
                finalUrl
            });
        }

        return res.json({
            success: true,
            data: extractedData
        });
    } catch (error) {
        console.error('Extraction Error:', error.message);

        return res.status(500).json({
            success: false,
            error:
                error.message ||
                'Server error occurred during extraction.'
        });
    }
});

// =========================================================
// SHREE STORE — GitHub Configuration
// =========================================================

const GITHUB_OWNER =
    process.env.GITHUB_OWNER || 'everythinghere99';

const GITHUB_REPO =
    process.env.GITHUB_REPO || 'everythinghere99.github.io';

const GITHUB_BRANCH =
    process.env.GITHUB_BRANCH || 'main';

const GITHUB_FILE_PATH =
    process.env.GITHUB_FILE_PATH || 'script.js';

const GITHUB_TOKEN =
    process.env.GITHUB_TOKEN || '';

const ADMIN_KEY =
    process.env.ADMIN_KEY || '';

// =========================================================
// Public GitHub Raw URL
// =========================================================

function getPublicGitHubRawUrl() {
    const encodedPath = GITHUB_FILE_PATH
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');

    return (
        `https://raw.githubusercontent.com/` +
        `${GITHUB_OWNER}/` +
        `${GITHUB_REPO}/` +
        `${GITHUB_BRANCH}/` +
        encodedPath
    );
}

// =========================================================
// Product Description Generator
// =========================================================

function makeProductDescription(name) {
    const title = String(name || 'Product')
        .replace(/\s+/g, ' ')
        .trim();

    const lower = title.toLowerCase();

    if (
        lower.includes('watch') ||
        lower.includes('smartwatch')
    ) {
        return `Smart ${title} with useful everyday features and a stylish, convenient design.`;
    }

    if (
        lower.includes('dress') ||
        lower.includes('kurti') ||
        lower.includes('shirt') ||
        lower.includes('top') ||
        lower.includes('pant') ||
        lower.includes('jogger') ||
        lower.includes('wear')
    ) {
        return `Stylish ${title} designed for a comfortable fit and an easy everyday look.`;
    }

    if (
        lower.includes('shoe') ||
        lower.includes('sandal') ||
        lower.includes('slipper')
    ) {
        return `Comfortable ${title} made for everyday use with a practical and stylish look.`;
    }

    if (
        lower.includes('earring') ||
        lower.includes('jewellery') ||
        lower.includes('jewelry') ||
        lower.includes('necklace') ||
        lower.includes('bracelet')
    ) {
        return `Elegant ${title} that adds a simple and stylish touch to your everyday look.`;
    }

    if (
        lower.includes('lamp') ||
        lower.includes('light')
    ) {
        return `Useful ${title} with a practical design for a cozy and convenient setup.`;
    }

    return `Useful ${title} with a stylish design, made for convenient everyday use.`;
}

function jsString(value) {
    return JSON.stringify(
        String(value ?? '')
            .replace(/\r?\n/g, ' ')
            .trim()
    );
}

function buildProductCode({
    id,
    name,
    image,
    price,
    affiliateLink
}) {
    const description = makeProductDescription(name);

    const cleanPrice =
        String(price || '').trim() || '₹0';

    const imageUrls = String(image || '')
        .split(/\r?\n|,/)
        .map(x => x.trim())
        .filter(Boolean);

    const uniqueImages = [...new Set(imageUrls)];

    const imagesCode = uniqueImages.length
        ? uniqueImages
              .map(url => `        ${jsString(url)}`)
              .join(',\n')
        : `        ${jsString('')}`;

    return `{
    id: ${jsString(id)},
    name: ${jsString(name)},
    images: [
${imagesCode}
    ],
    description: ${jsString(description)},
    price: ${jsString(cleanPrice)},
    affiliateLink: ${jsString(affiliateLink)}
},`;
}

function findNextShreeProductId(script) {
    if (typeof script !== 'string' || !script.trim()) {
        throw new Error('script.js content is empty.');
    }

    const affiliateStart =
        script.indexOf('const affiliateProducts = [');

    if (affiliateStart === -1) {
        throw new Error(
            'affiliateProducts array not found in script.js'
        );
    }

    const afterStart = script.slice(affiliateStart);

    const closingMatch = afterStart.match(/\n\s*\];/);

    if (!closingMatch || closingMatch.index === undefined) {
        throw new Error(
            'affiliateProducts closing ]; not found.'
        );
    }

    const affiliateEnd =
        affiliateStart + closingMatch.index;

    const affiliateBlock = script.slice(
        affiliateStart,
        affiliateEnd
    );

    const matches = [
        ...affiliateBlock.matchAll(
            /id\s*:\s*["']SHREE-P(\d+)["']/g
        )
    ];

    let highest = 0;

    for (const match of matches) {
        const number = Number.parseInt(match[1], 10);

        if (
            Number.isInteger(number) &&
            number > highest
        ) {
            highest = number;
        }
    }

    return {
        id: `SHREE-P${String(highest + 1).padStart(2, '0')}`,
        affiliateEnd
    };
}

async function getGitHubFile() {
    if (!GITHUB_TOKEN) {
        throw new Error(
            'GITHUB_TOKEN is missing in Render environment variables.'
        );
    }

    const apiUrl =
        `https://api.github.com/repos/` +
        `${encodeURIComponent(GITHUB_OWNER)}/` +
        `${encodeURIComponent(GITHUB_REPO)}/` +
        `contents/${GITHUB_FILE_PATH}`;

    const response = await axios.get(apiUrl, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Shree-Store-Extractor'
        },
        params: {
            ref: GITHUB_BRANCH
        },
        timeout: 20000
    });

    if (!response.data || !response.data.content) {
        throw new Error(
            'GitHub returned an invalid script.js response.'
        );
    }

    return {
        apiUrl,
        sha: response.data.sha,
        content: Buffer.from(
            response.data.content,
            'base64'
        ).toString('utf8')
    };
}

async function getPublicGitHubScript() {
    const rawUrl = getPublicGitHubRawUrl();

    const response = await axios.get(rawUrl, {
        headers: {
            'User-Agent': 'Shree-Store-Extractor',
            Accept: 'text/plain'
        },
        timeout: 20000,
        responseType: 'text'
    });

    if (
        typeof response.data !== 'string' ||
        !response.data.trim()
    ) {
        throw new Error(
            'Unable to read public script.js from GitHub.'
        );
    }

    return response.data;
}

// =========================================================
// COPY PRODUCT CODE — DOES NOT MODIFY GITHUB
// =========================================================

app.post('/api/generate-product-code', async (req, res) => {
    try {
        const {
            name,
            price,
            image,
            affiliateLink
        } = req.body || {};

        if (!name || !image || !affiliateLink) {
            return res.status(400).json({
                success: false,
                error:
                    'Name, image and affiliateLink are required.'
            });
        }

        const script = await getPublicGitHubScript();

        const { id } = findNextShreeProductId(script);

        const code = buildProductCode({
            id,
            name,
            image,
            price,
            affiliateLink
        });

        return res.json({
            success: true,
            productId: id,
            code
        });
    } catch (error) {
        console.error(
            'Generate Product Code Error:',
            error.message
        );

        return res.status(500).json({
            success: false,
            error:
                error.message ||
                'Product code generation failed.'
        });
    }
});

// =========================================================
// DIRECT GITHUB UPDATE
// =========================================================

app.post('/api/add-product-to-github', async (req, res) => {
    try {
        const adminKey =
            req.headers['x-admin-key'] || '';

        if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
            return res.status(401).json({
                success: false,
                error: 'Invalid admin key.'
            });
        }

        const {
            name,
            price,
            image,
            affiliateLink
        } = req.body || {};

        if (!name || !image || !affiliateLink) {
            return res.status(400).json({
                success: false,
                error:
                    'Name, image and affiliateLink are required.'
            });
        }

        const githubFile = await getGitHubFile();

        const {
            id,
            affiliateEnd
        } = findNextShreeProductId(
            githubFile.content
        );

        const productCode = buildProductCode({
            id,
            name,
            image,
            price,
            affiliateLink
        });

        const updatedContent =
            githubFile.content.slice(
                0,
                affiliateEnd
            ) +
            '\n' +
            productCode +
            githubFile.content.slice(
                affiliateEnd
            );

        const encodedContent =
            Buffer.from(
                updatedContent,
                'utf8'
            ).toString('base64');

        const updateResponse =
            await axios.put(
                githubFile.apiUrl,
                {
                    message:
                        `Add ${id} to affiliateProducts`,
                    content:
                        encodedContent,
                    sha:
                        githubFile.sha,
                    branch:
                        GITHUB_BRANCH
                },
                {
                    headers: {
                        Authorization:
                            `Bearer ${GITHUB_TOKEN}`,
                        Accept:
                            'application/vnd.github+json',
                        'X-GitHub-Api-Version':
                            '2022-11-28',
                        'User-Agent':
                            'Shree-Store-Extractor'
                    },
                    timeout: 20000
                }
            );

        return res.json({
            success: true,
            productId: id,
            message:
                `${id} successfully added to GitHub.`,
            commit:
                updateResponse.data?.commit?.sha || ''
        });
    } catch (error) {
        console.error(
            'GitHub Update Error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            error:
                error.response?.data?.message ||
                error.message ||
                'GitHub update failed.'
        });
    }
});

// =========================================================
// Start server
// =========================================================

app.listen(PORT, () => {
    console.log(
        `🚀 Server running on http://localhost:${PORT}`
    );

    console.log(
        `📦 Admin Panel: http://localhost:${PORT}/admin.html`
    );
});
