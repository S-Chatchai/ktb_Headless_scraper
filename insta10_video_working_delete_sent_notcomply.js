const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();
const nodemailer = require("nodemailer");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// dynamic fetch import for Node.js CommonJS
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// --- Setup Gemini API Key Rotation ---
const geminiKeys = process.env.GEMINI_API_KEYS ?
    process.env.GEMINI_API_KEYS.split(",") :
    ["YOUR_API_KEY_HERE"];
let geminiKeyIndex = 0;

function getNextGeminiKey() {
    const key = geminiKeys[geminiKeyIndex];
    geminiKeyIndex = (geminiKeyIndex + 1) % geminiKeys.length;
    return key;
}

// --- Email Config ---
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER || "GMAIL_USER",
        pass: process.env.GMAIL_PASS || "GMAIL_PASS"
    }
});

// --- Folders for saving ---
const folderPath = path.join(__dirname, "instapost");
const geminiFolder = path.join(__dirname, "geminitext");
if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
if (!fs.existsSync(geminiFolder)) fs.mkdirSync(geminiFolder);
if (!fs.existsSync(path.join(__dirname, "downloads"))) fs.mkdirSync(path.join(__dirname, "downloads"));

// --- File to store last scraped posts ---
const lastPostFile = path.join(__dirname, "lastPost.json");

// --- Convert media to base64 ---
function mediaToBase64(filePath) {
    const mediaBuffer = fs.readFileSync(filePath);
    return mediaBuffer.toString("base64");
}

// --- Scrape caption + timestamp + media ---
async function scrapePost(browser, url) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2" });

    // 2. 🛡️ เพิ่มการรอนาที (time) element อย่างชัดเจน
    try {
        await page.waitForSelector("time", { timeout: 10000 }); // รอสูงสุด 10 วินาที
    } catch (error) {
        console.warn(`⚠️ Time element not found within timeout on ${url}. Proceeding with best effort.`);
        // ไม่ต้องหยุดทำงาน แต่จะพยายามดึงข้อมูลอื่น ๆ ต่อไป
    }

    // 3. ดึง timestamp (เปลี่ยนมาใช้ $eval ภายใน try/catch เพื่อป้องกันการพัง)
    let timestamp = "No timestamp";
    try {
        timestamp = await page.$eval("time", el => el.getAttribute("datetime"));
    } catch (e) {
        // ถ้า $eval พังเพราะหา time ไม่เจอ จะใช้ค่า default
    }

    const caption = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        if (h1?.innerText.trim().length) return h1.innerText.trim();

        const reelSpan = document.querySelector("div[role='presentation'] div span");
        if (reelSpan?.innerText.trim().length) return reelSpan.innerText.trim();

        const longSpan = Array.from(document.querySelectorAll("span"))
            .find(el => el.innerText && el.innerText.length > 20);
        return longSpan ? longSpan.innerText.trim() : "No caption";
    });

    const media = await page.evaluate(() => {
        const video = document.querySelector("video");
        if (video?.src) return { type: "video", url: video.src };

        const imgs = Array.from(document.querySelectorAll("div img"))
            .map(el => el.src)
            .filter(src => src && !src.includes("profile") && !src.includes("emoji"));
        if (imgs.length > 0) return { type: "image", url: imgs[0] };

        return { type: "none", url: null };
    });

    await page.close();
    return { url, timestamp, caption, media };
}

// --- Download image or call Python for video ---
async function downloadMedia(media, fileName, url) {
    if (!media || !media.url) return null;

    if (media.type === "image") {
        try {
            const fileNameBase = fileName.replace(".txt", ".jpg");
            const filePath = path.join(folderPath, fileNameBase);

            const res = await fetch(media.url);
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(filePath, buffer);

            console.log(`🖼️ Image saved to ${filePath}`);
            return filePath;
        } catch (err) {
            console.error("❌ Failed to download image:", err);
            return null;
        }
    }

    if (media.type === "video") {
        return new Promise((resolve, reject) => {
            const customVideoName = fileName.replace(".txt", ".mp4");
            const pythonProcess = spawn("python", ["download_instagram_video.py", url, customVideoName]);

            pythonProcess.stdout.on("data", (data) => console.log(`${data}`));
            pythonProcess.stderr.on("data", (data) => console.error(`${data}`));

            pythonProcess.on("close", (code) => {
                if (code === 0) {
                    const downloadedFile = path.join(__dirname, "downloads", customVideoName);
                    console.log(`🎬 Video saved to ${downloadedFile}`);
                    resolve(downloadedFile);
                } else {
                    reject(`Python process exited with code ${code}`);
                }
            });
        });
    }

    return null;
}

// --- Call Gemini to analyze caption + media with key rotation and retry logic ---
async function analyzeWithGemini(caption, mediaPath, mediaType) {
    const maxRetries = 3;
    let retries = 0;
    let delay = 1000; // 1 second

    while (retries < maxRetries) {
        try {
            const apiKey = getNextGeminiKey();
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const parts = [{
                text: `คุณเป็นผู้ช่วยตรวจสอบโฆษณาสินเชื่อที่มีความเชี่ยวชาญในหลักเกณฑ์การให้สินเชื่ออย่างรับผิดชอบและเป็นธรรม (Responsible Lending) ของธนาคารแห่งประเทศไทย

งานของคุณคือ:

ขั้นตอนที่ 1: ตรวจสอบเบื้องต้น

พิจารณา Caption รูปภาพ หรือวิดีโอ ว่าเป็น โฆษณา “การให้กู้เงิน” หรือ “การเสนอวงเงินสินเชื่อ” โดยตรงหรือไม่

ถือว่า “เกี่ยวข้องกับสินเชื่อ” เฉพาะกรณีที่เนื้อหามีจุดประสงค์เพื่อชักชวนให้กู้หรือขอวงเงิน เช่น:

โฆษณาสินเชื่อส่วนบุคคล / สินเชื่อเงินสด / สินเชื่อบ้าน / สินเชื่อรถ / สินเชื่อ SME

มีข้อความชักชวนให้กู้ เช่น “กู้ง่าย”, “วงเงินสูง”, “อนุมัติไว”, “สมัครสินเชื่อได้เลย”, “ดอกเบี้ยพิเศษสำหรับผู้กู้ใหม่”

ระบุอัตราดอกเบี้ยหรือค่างวด ในบริบทของการกู้ยืม

ไม่ถือว่าเกี่ยวข้องกับสินเชื่อ หากโฆษณาเป็นการประชาสัมพันธ์หรือส่งเสริมสิทธิประโยชน์ของผลิตภัณฑ์ทางการเงินอื่น ๆ เช่น:

บัตรเครดิต (ที่เน้นสิทธิพิเศษ เช่น คะแนนสะสม, ส่วนลดร้านอาหาร, สิทธิ์ห้องรับรองสนามบิน)

ประกันชีวิต/สุขภาพ/อุบัติเหตุ

การลงทุน กองทุน หุ้น ตราสารหนี้

การป้องกันมิจฉาชีพ หรือการประชาสัมพันธ์ทั่วไปของธนาคาร

ดังนั้น

ถ้า ไม่เกี่ยวข้องกับสินเชื่อ → ให้ตอบทันทีว่า: “ไม่เกี่ยวกับสินเชื่อ”

ถ้า เกี่ยวข้องกับสินเชื่อ → ให้ตอบทันทีว่า: “เกี่ยวกับสินเชื่อ” แล้วไปขั้นตอนถัดไป

ขั้นตอนที่ 2: ตรวจสอบเชิงลึก (เฉพาะกรณีที่เกี่ยวข้อง)
ถ้าสอดคล้องทุกข้อ → COMPLY: พร้อมให้เหตุผลสั้น ๆ ว่าโฆษณานี้เป็นไปตามหลักเกณฑ์สำคัญอย่างไร

ถ้าไม่สอดคล้อง → NOT COMPLY: พร้อมระบุทุกประเด็นที่ไม่สอดคล้องเป็นข้อ ๆ โดยอ้างอิงหมายเลขหัวข้อหลักเกณฑ์ (1, 2, หรือ 3) และอธิบายเหตุผลประกอบอย่างชัดเจน

หลักเกณฑ์ฉบับเต็มที่ใช้ในการตรวจสอบ (อ้างอิงเอกสารแนบ 2)

1. โฆษณาต้อง "ถูกต้อง ครบถ้วน และชัดเจน"
เนื้อหาต้องแจ้งข้อมูลสำคัญให้ชัดเจน เข้าใจง่าย ไม่บิดเบือน หรือทำให้เข้าใจผิดในสาระสำคัญ.
การแสดงผล เช่น ขนาดตัวอักษร ต้องมองเห็นได้ชัดเจน หรือความเร็วในการอ่านออกเสียงต้องเท่ากับเนื้อหาอื่น.
หากโฆษณาโดยใช้อัตราดอกเบี้ยหรือค่าธรรมเนียมพิเศษเพื่อจูงใจ จะต้องแสดงเงื่อนไขสำคัญที่เกี่ยวข้องไว้ในโฆษณาชิ้นเดียวกันอย่างครบถ้วนและชัดเจน.
ตัวอย่างที่ไม่เป็นไปตามหลักเกณฑ์: โฆษณาว่า "ฟรีค่าธรรมเนียมรายปี" แต่ไม่แจ้งว่าเป็นสิทธิพิเศษเฉพาะปีแรกเท่านั้น หรือโฆษณา "ดอกเบี้ย 0%" แต่ไม่แจ้งว่าเป็นกรณีที่ลูกค้าชำระเต็มจำนวนภายในวันครบกำหนดเท่านั้น.

2. โฆษณาต้อง "เปรียบเทียบเงื่อนไข ดอกเบี้ย และค่าธรรมเนียมต่าง ๆ ได้"
ต้องแสดง "อัตราดอกเบี้ยที่แท้จริงต่อปี (Effective Interest Rate)" เป็นช่วงระหว่างอัตราดอกเบี้ยต่ำสุดและสูงสุด (ที่ไม่ใช่อัตราดอกเบี้ยพิเศษชั่วคราว) ในโฆษณาชิ้นเดียวกัน.
กรณีดอกเบี้ยลอยตัว (Floating Rate) ต้องระบุสมมติฐานการคำนวณ วันที่ใช้อัตราดอกเบี้ยอ้างอิง และต้องมีข้อความว่า "อัตราดอกเบี้ยลอยตัวสามารถเปลี่ยนแปลงเพิ่มขึ้นหรือลดลงได้".
หากใช้ข้อมูลยอดผ่อนชำระเพื่อจูงใจลูกค้า จะต้องแสดงข้อมูล เงินต้น, อัตราดอกเบี้ย, จำนวนดอกเบี้ยทั้งสัญญา, ค่างวด และระยะเวลาชำระคืนทั้งหมด ให้ชัดเจนในโฆษณาชิ้นเดียวกัน.

3. โฆษณาต้อง "ไม่กระตุ้นให้ก่อหนี้เกินควร"
คำเตือนที่ต้องมี:
สินเชื่อทั่วไป: ต้องแสดงคำเตือน "กู้เท่าที่จำเป็นและชำระคืนไหว" ในโฆษณาทุกประเภทอย่างชัดเจน.
บัตรเครดิต: ต้องแสดงคำเตือนว่า "ใช้เท่าที่จำเป็นและชำระคืนได้เต็มจำนวนตามกำหนด จะได้ไม่เสียดอกเบี้ย (ตามด้วยช่วงอัตราดอกเบี้ย)".
ถ้อยคำและภาพที่ห้ามใช้:
ห้ามใช้ถ้อยคำที่ทำให้เข้าใจว่าการอนุมัติสินเชื่อเป็นเรื่องง่าย หรือไม่ได้พิจารณาความสามารถในการชำระหนี้ เช่น "ใคร ๆ ก็กู้ได้", "กู้ง่าย", “อนุมัติง่าย", "ไม่เช็คบูโร", "ติดบูโรก็กู้ได้".
ห้ามใช้ถ้อยคำหรือภาพที่ส่งเสริมให้ใช้จ่ายเกินตัว เช่น "ของมันต้องมี อยากได้ต้องได้", "ไฮโซก่อน ค่อยผ่อนทีหลัง".
การส่งเสริมการขาย: ห้ามทำการตลาดที่ให้รางวัลหรือของขวัญแก่ลูกค้า "เพียงแค่สมัคร" โดยที่ลูกค้ายังไม่ผ่านการพิจารณาอนุมัติสินเชื่อ.

ข้อกำหนดเพิ่มเติม:
อย่าใส่ JSON, code block หรือคำอธิบายอื่นนอกเหนือจากที่กำหนดในคำสั่ง
มีคนในรูป หรือ วิดีโอกี่คน

โฆษณาที่ต้องการตรวจสอบ:
Caption: ${caption}`
            }];

            if (mediaPath && fs.existsSync(mediaPath)) {
                const base64Data = mediaToBase64(mediaPath);

                if (mediaType === "video") {
                    parts.push({
                        inlineData: {
                            mimeType: "video/mp4",
                            data: base64Data
                        }
                    });
                } else if (mediaType === "image") {
                    parts.push({
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: base64Data
                        }
                    });
                }
            }

            const result = await model.generateContent(parts);
            let text = result.response.text().trim();
            text = text.replace(/^json\s*/i, "").replace(/```/g, "").trim();
            return text;
        } catch (err) {
            if (err.status === 503 && retries < maxRetries - 1) {
                console.warn(`⚠️ Gemini API 503 error. Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                retries++;
                delay *= 2; // Double the delay for the next attempt
            } else {
                throw err;
            }
        }
    }
}

// --- Send email (MODIFIED to accept custom subject) ---
async function sendEmail(post, geminiResult, mediaPath, customOptions = {}) {
    const attachments = mediaPath ? [{ filename: path.basename(mediaPath), path: mediaPath }] : [];

    // Use custom subject if provided, otherwise default subject
    const subject = customOptions.subject || `✅ YES - Instagram Post ${post.timestamp}`;

    const mailOptions = {
        from: process.env.GMAIL_USER,
        to: [process.env.GMAIL_USER], //"ammarin.wangkeeree@krungthai.com"]
        subject: subject,
        text: `URL: ${post.url}\nTimestamp: ${post.timestamp}\nCaption: ${post.caption}\n\nGemini Result:\n${geminiResult}`,
        attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("📧 Email sent successfully.");
    } catch (err) {
        console.error("❌ Error sending email:", err);
    }
}

// --- Scrape newest posts (MODIFIED logic for NOT COMPLY email) ---
async function scrapeNewestPosts(count = 5, delaySeconds = 30) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    console.log("🌐 Going to Instagram page...");
    await page.goto("https://www.instagram.com/krungthai_care/", { waitUntil: "networkidle2" });
    await page.waitForSelector("article a");

    const postLinks = await page.$$eval("article a", links => links.map(a => a.href));
    const candidateLinks = postLinks.slice(0, count);

    const candidatePosts = [];
    for (const url of candidateLinks) {
        try {
            const post = await scrapePost(browser, url);
            candidatePosts.push(post);
        } catch (err) {
            console.error(`❌ Failed to scrape ${url}:`, err);
        }
    }

    candidatePosts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let lastPosts = fs.existsSync(lastPostFile) ? JSON.parse(fs.readFileSync(lastPostFile, "utf-8")) : [];

    for (const post of candidatePosts) {
        if (lastPosts.find(p => p.url === post.url)) {
            console.log(`⏩ Post already processed: ${post.url}`);
            continue;
        }

        const fileName = `post_${new Date(post.timestamp).toISOString().replace(/[:.]/g, "-")}.txt`;
        const filePath = path.join(folderPath, fileName);
        fs.writeFileSync(filePath, `URL: ${post.url}\nTimestamp: ${post.timestamp}\nCaption: ${post.caption}`);
        console.log(`💾 Saved post to ${filePath}`);

        const mediaPath = await downloadMedia(post.media, fileName, post.url);

        // --- Check cache ---
        const geminiFile = path.join(geminiFolder, fileName.replace(".txt", "_gemini.txt"));
        let geminiOutput;
        if (fs.existsSync(geminiFile)) {
            geminiOutput = fs.readFileSync(geminiFile, "utf-8");
            console.log(`📂 Gemini response loaded from cache: ${geminiFile}`);
        } else {
            console.log("📡 Sending caption + media to Gemini...");
            geminiOutput = await analyzeWithGemini(post.caption, mediaPath, post.media.type);
            fs.writeFileSync(geminiFile, geminiOutput);
            console.log(`💾 Gemini response saved to: ${geminiFile}`);

            console.log(`⏳ Waiting ${delaySeconds} seconds before next Gemini call...`);
            await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }

        // --- Check for "เกี่ยวกับสินเชื่อ" AND "NOT COMPLY" to trigger email ---
        const isLoanAd = geminiOutput.toUpperCase().startsWith("เกี่ยวกับสินเชื่อ");
        const isNotComply = geminiOutput.toUpperCase().includes("NOT COMPLY");

        if (isLoanAd && isNotComply) {
            console.log("🚨 Found a non-compliant loan ad. Sending email alert...");
            const customMailOptions = {
                subject: `🚨 ACTION REQUIRED - NOT COMPLY Instagram Ad: ${post.timestamp}`
            };
            await sendEmail(post, geminiOutput, mediaPath, customMailOptions);
        } else {
            console.log("ℹ️ Post is either NOT an Ad or is COMPLY → No email sent.");
        }

        lastPosts.push({ url: post.url, timestamp: post.timestamp });
    }

    fs.writeFileSync(lastPostFile, JSON.stringify(lastPosts));
    await browser.close();
}

// --- Cleanup old files after everything done ---
async function cleanupFiles() {
    const deleteFolderContents = (folder) => {
        if (fs.existsSync(folder)) {
            for (const file of fs.readdirSync(folder)) {
                const filePath = path.join(folder, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            }
            console.log(`🧹 Cleared all files in ${folder}`);
        }
    };

    deleteFolderContents(folderPath); // ลบ caption + media ที่เก็บไว้
    deleteFolderContents(path.join(__dirname, "downloads")); // ลบวิดีโอที่โหลดด้วย python
    deleteFolderContents(geminiFolder); // ✅ ลบผลลัพธ์จาก Gemini (ไฟล์ .txt)
}

// --- Run job ---
scrapeNewestPosts(3, 5)
    // .then(() => cleanupFiles())
    // .catch(err => console.error("❌ Error:", err));
