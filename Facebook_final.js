const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config();
const nodemailer = require("nodemailer");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Setup Gemini ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- Email Config ---
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
});

// --- Folders ---
const folderPath = path.join(__dirname, "fbpost");
const geminiFolder = path.join(__dirname, "fbgeminitext");
if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
if (!fs.existsSync(geminiFolder)) fs.mkdirSync(geminiFolder);

const lastPostFile = path.join(__dirname, "lastFBPost.json");

// --- Helpers ---
function normalizeTimestamp(msTimestamp) {
    return new Date(msTimestamp).toISOString().split('.')[0] + "Z";
}

function parseFBTime(fbTimeStr) {
    const now = new Date();
    if (!fbTimeStr) return now;
    fbTimeStr = fbTimeStr.toLowerCase();
    if (fbTimeStr.includes("just now")) return now;
    const match = fbTimeStr.match(/(\d+)([mhwd])/i);
    if (!match) return now;
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
        case "m": return new Date(now - value * 60 * 1000);
        case "h": return new Date(now - value * 60 * 60 * 1000);
        case "d": return new Date(now - value * 24 * 60 * 60 * 1000);
        case "w": return new Date(now - value * 7 * 24 * 60 * 60 * 1000);
        default: return now;
    }
}

function extractPostId(url) {
    if (!url) return null;
    const cleanUrl = url.split("?")[0];
    return crypto.createHash("md5").update(cleanUrl).digest("hex");
}

async function downloadImage(url, filePath) {
    if (!url) return null;
    try {
        const response = await axios({ url, responseType: 'stream' });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(filePath));
            writer.on('error', reject);
        });
    } catch (err) {
        console.error("❌ Error downloading image:", err);
        return null;
    }
}

async function scrapeFBPost(browser, url) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: "networkidle2" });
        await page.waitForSelector('[role="article"]', { timeout: 15000 });

        const postData = await page.evaluate(() => {
            const post = document.querySelector('[role="article"]');
            if (!post) return { fullText: "No caption", imageUrl: null, timeText: null };

            let text = "";
            const elements = Array.from(post.querySelectorAll("div, span, p"));
            elements.forEach(el => { if (el.innerText) text += el.innerText.trim() + " "; });
            let fullText = text.trim();

            const cutKeywords = ["All reactions:", "Like", "Comment", "Share"];
            for (const keyword of cutKeywords) {
                const idx = fullText.indexOf(keyword);
                if (idx !== -1) fullText = fullText.slice(0, idx).trim();
            }

            const imageEls = Array.from(post.querySelectorAll('img'));
            let imageUrl = null;
            for (const img of imageEls) {
                if (img.src && img.src.startsWith('https://') && img.width > 100 && img.height > 100) {
                    imageUrl = img.src;
                    break;
                }
            }

            const timeEl = post.querySelector("abbr[data-utime], time, span");
            const timeText = timeEl ? timeEl.innerText.trim() : null;

            return { fullText, imageUrl, timeText };
        });

        const timestamp = parseFBTime(postData.timeText);
        await page.close();
        return { url, fullText: postData.fullText, timestamp, imageUrl: postData.imageUrl };
    } catch (err) {
        console.error("❌ Failed to scrape post:", err);
        await page.close();
        return null;
    }
}

async function downloadReel(postUrl) {
    return new Promise((resolve, reject) => {
        const pyProcess = spawn("python", [path.join(__dirname, "download_reel.py"), postUrl]);
        let stdout = "", stderr = "";
        pyProcess.stdout.on("data", data => { stdout += data.toString(); });
        pyProcess.stderr.on("data", data => { stderr += data.toString(); });
        pyProcess.on("close", code => {
            if (code !== 0) return reject(stderr);
                // console.log("📌 Raw stdout from Python:", stdout);  // <-- เพิ่มตรงนี้

            try {
                // แยก JSON ล่าสุดจาก stdout
                const jsonStart = stdout.lastIndexOf("{");
                const jsonEnd = stdout.lastIndexOf("}") + 1;
                const jsonStr = stdout.slice(jsonStart, jsonEnd);
                    // console.log("📌 Raw stdout from Python:", stdout);  // <-- เพิ่มตรงนี้
                resolve(JSON.parse(jsonStr));
            } catch (err) {
                reject("❌ Failed to parse JSON from Python: " + err + "\nOutput:\n" + stdout);
            }
        });
    });
}


async function analyzeWithGemini(textContent, imagePath, videoPaths = []) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const parts = [];

    // ส่ง text เฉพาะถ้ามี
    if (textContent && textContent.trim().length > 0) {
        parts.push({
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

โฆษณาต้อง "ถูกต้อง ครบถ้วน และชัดเจน"
เนื้อหาต้องแจ้งข้อมูลสำคัญให้ชัดเจน เข้าใจง่าย ไม่บิดเบือน หรือทำให้เข้าใจผิดในสาระสำคัญ.
การแสดงผล เช่น ขนาดตัวอักษร ต้องมองเห็นได้ชัดเจน หรือความเร็วในการอ่านออกเสียงต้องเท่ากับเนื้อหาอื่น.
หากโฆษณาโดยใช้อัตราดอกเบี้ยหรือค่าธรรมเนียมพิเศษเพื่อจูงใจ จะต้องแสดงเงื่อนไขสำคัญที่เกี่ยวข้องไว้ในโฆษณาชิ้นเดียวกันอย่างครบถ้วนและชัดเจน.
ตัวอย่างที่ไม่เป็นไปตามหลักเกณฑ์: โฆษณาว่า "ฟรีค่าธรรมเนียมรายปี" แต่ไม่แจ้งว่าเป็นสิทธิพิเศษเฉพาะปีแรกเท่านั้น หรือโฆษณา "ดอกเบี้ย 0%" แต่ไม่แจ้งว่าเป็นกรณีที่ลูกค้าชำระเต็มจำนวนภายในวันครบกำหนดเท่านั้น.

โฆษณาต้อง "เปรียบเทียบเงื่อนไข ดอกเบี้ย และค่าธรรมเนียมต่าง ๆ ได้"
ต้องแสดง "อัตราดอกเบี้ยที่แท้จริงต่อปี (Effective Interest Rate)" เป็นช่วงระหว่างอัตราดอกเบี้ยต่ำสุดและสูงสุด (ที่ไม่ใช่อัตราดอกเบี้ยพิเศษชั่วคราว) ในโฆษณาชิ้นเดียวกัน.
กรณีดอกเบี้ยลอยตัว (Floating Rate) ต้องระบุสมมติฐานการคำนวณ วันที่ใช้อัตราดอกเบี้ยอ้างอิง และต้องมีข้อความว่า "อัตราดอกเบี้ยลอยตัวสามารถเปลี่ยนแปลงเพิ่มขึ้นหรือลดลงได้".
หากใช้ข้อมูลยอดผ่อนชำระเพื่อจูงใจลูกค้า จะต้องแสดงข้อมูล เงินต้น, อัตราดอกเบี้ย, จำนวนดอกเบี้ยทั้งสัญญา, ค่างวด และระยะเวลาชำระคืนทั้งหมด ให้ชัดเจนในโฆษณาชิ้นเดียวกัน.

โฆษณาต้อง "ไม่กระตุ้นให้ก่อหนี้เกินควร"
คำเตือนที่ต้องมี:
สินเชื่อทั่วไป: ต้องแสดงคำเตือน "กู้เท่าที่จำเป็นและชำระคืนไหว" ในโฆษณาทุกประเภทอย่างชัดเจน.
บัตรเครดิต: ต้องแสดงคำเตือนว่า "ใช้เท่าที่จำเป็นและชำระคืนได้เต็มจำนวนตามกำหนด จะได้ไม่เสียดอกเบี้ย (ตามด้วยช่วงอัตราดอกเบี้ย)".
ถ้อยคำและภาพที่ห้ามใช้:
ห้ามใช้ถ้อยคำที่ทำให้เข้าใจว่าการอนุมัติสินเชื่อเป็นเรื่องง่าย หรือไม่ได้พิจารณาความสามารถในการชำระหนี้ เช่น "ใคร ๆ ก็กู้ได้", "กู้ง่าย", "อนุมัติง่าย", "ไม่เช็คบูโร", "ติดบูโรก็กู้ได้".
ห้ามใช้ถ้อยคำหรือภาพที่ส่งเสริมให้ใช้จ่ายเกินตัว เช่น "ของมันต้องมี อยากได้ต้องได้", "ไฮโซก่อน ค่อยผ่อนทีหลัง".
การส่งเสริมการขาย: ห้ามทำการตลาดที่ให้รางวัลหรือของขวัญแก่ลูกค้า "เพียงแค่สมัคร" โดยที่ลูกค้ายังไม่ผ่านการพิจารณาอนุมัติสินเชื่อ.

ข้อกำหนดเพิ่มเติม:
อย่าใส่ JSON, code block หรือคำอธิบายอื่นนอกเหนือจากที่กำหนดในคำสั่ง
มีคนในรูป หรือ วิดีโอกี่คน

โฆษณาที่ต้องการตรวจสอบ:
Caption: \n${textContent}`
        });
    }

    if (imagePath && fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        parts.push({ inlineData: { mimeType: "image/jpeg", data: imageBuffer.toString("base64") } });
    }

    for (const videoPath of videoPaths) {
        if (fs.existsSync(videoPath)) {
            const videoBuffer = fs.readFileSync(videoPath);
            parts.push({ inlineData: { mimeType: "video/mp4", data: videoBuffer.toString("base64") } });
        }
    }

    // ❌ เช็คว่า parts มี content อย่างน้อย 1 อย่าง
    if (parts.length === 0) {
        console.warn("⚠️ No content to send to Gemini.");
        return "NO CONTENT";
    }

    try {
        const result = await model.generateContent(parts);
        return result.response.text().trim();
    } catch (err) {
        console.error("❌ Gemini error:", err);
        return "";
    }
}


async function sendEmail(post, geminiResult, imagePath, videoPaths = []) {
    const attachments = [];
    if (imagePath) attachments.push({ filename: path.basename(imagePath), path: imagePath });
    for (const v of videoPaths) attachments.push({ filename: path.basename(v), path: v });

    // ตรวจสอบว่าผลลัพธ์มี NOT COMPLY เพื่อปรับ Subject ให้ชัดเจนขึ้น
    const isNotComply = geminiResult.toUpperCase().includes("NOT COMPLY");
    // เนื่องจากฟังก์ชันนี้จะถูกเรียกเฉพาะกรณีที่เข้าเงื่อนไข "เกี่ยวกับสินเชื่อ" AND "NOT COMPLY" 
    // จึงสามารถระบุ Subject ให้ชัดเจนว่าเป็นการแจ้งเตือน NOT COMPLY ได้เลย
    const subject = isNotComply 
        ? `⚠️ NOT COMPLY (Loan Ad) - FB Post ${normalizeTimestamp(post.timestamp)}`
        : `❌ Unexpected COMPLY/Other Ad - FB Post ${normalizeTimestamp(post.timestamp)}`; // ใช้ Subject นี้เป็น Fallback แต่ไม่น่าจะเกิด

    const mailOptions = {
        from: process.env.GMAIL_USER,
        to: process.env.GMAIL_USER,
        subject: subject,
        text: `URL: ${post.url}\nTimestamp: ${normalizeTimestamp(post.timestamp)}\nCaption: ${post.fullText}\n\nGemini Result:\n${geminiResult}`,
        attachments
    };

    try { await transporter.sendMail(mailOptions); console.log("✅ Email sent."); }
    catch (err) { console.error("❌ Error sending email:", err); }
}

async function autoScroll(page, scrollDelay = 1500, maxScrolls = 5) {
    for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise(resolve => setTimeout(resolve, scrollDelay));
    }
}

async function scrapeMultipleFBPosts() {
    let lastRecord = fs.existsSync(lastPostFile) ? JSON.parse(fs.readFileSync(lastPostFile, "utf-8")) : { processedPostIds: [] };

    const browser = await puppeteer.launch({ headless: false });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto("https://web.facebook.com/krungthaibank", { waitUntil: "networkidle2" });
        await page.keyboard.press("Escape");
        await page.waitForSelector("a[href*='/posts/'], a[href*='/pfbid'], a[href*='/reel/']", { timeout: 10000 });
        await autoScroll(page);

        const rawLinks = await page.$$eval("a[href*='/posts/'], a[href*='/pfbid'], a[href*='/reel/']", links => links.map(a => a.href));
        const postLinks = [...new Set(rawLinks)];
        console.log("✅ Found post/reel links:", postLinks);

        const numPostsToScrape = 100;

        for (let i = 0; i < Math.min(postLinks.length, numPostsToScrape); i++) {
            const postUrl = postLinks[i];
            let postData;

            if (postUrl.includes("/reel/")) {
                console.log("Reel detected, calling Python script...");
                try {
                    const pyResult = await downloadReel(postUrl);
                    // console.log("📌 Python result:", pyResult);  // <-- เพิ่มบรรทัดนี้ดู path
                    postData = {
                        url: postUrl,
                        fullText: pyResult.caption || "", 
                        timestamp: new Date(),
                        imageUrl: null,
                        videoFiles: pyResult.videos
                    };
                } catch (err) {
                    console.error("❌ Failed to download reel:", err);
                    continue;
                }
            } else {
                postData = await scrapeFBPost(browser, postUrl);
                if (!postData) continue;
                postData.videoFiles = [];
            }

            const postId = extractPostId(postData.url);
            if (!postId || lastRecord.processedPostIds.includes(postId)) continue;

            const baseFileName = `fbpost_${Date.now()}_${i}`;
            const textFilePath = path.join(folderPath, `${baseFileName}.txt`);
            if (postData.fullText) fs.writeFileSync(textFilePath, `URL: ${postData.url}\nTimestamp: ${normalizeTimestamp(postData.timestamp)}\nCaption: ${postData.fullText}`);
            console.log(`✅ Saved post text to ${textFilePath}`);

            let imagePath = null;
            if (postData.imageUrl) {
                imagePath = path.join(folderPath, `${baseFileName}.jpg`);
                await downloadImage(postData.imageUrl, imagePath);
            }

            const geminiOutput = await analyzeWithGemini(postData.fullText, imagePath, postData.videoFiles);
            fs.writeFileSync(path.join(geminiFolder, `${baseFileName}_gemini.txt`), geminiOutput);

            // 💡 เงื่อนไขใหม่: ส่งอีเมลเฉพาะเมื่อ "เกี่ยวกับสินเชื่อ" AND "NOT COMPLY"
            if (geminiOutput.toUpperCase().startsWith("เกี่ยวกับสินเชื่อ") && geminiOutput.toUpperCase().includes("NOT COMPLY")) {
                 await sendEmail(postData, geminiOutput, imagePath, postData.videoFiles);
            }
            
            lastRecord.processedPostIds.push(postId);
        }

        fs.writeFileSync(lastPostFile, JSON.stringify(lastRecord));
        console.log("✅ Updated last post record.");
    } catch (err) {
        console.error("❌ Main process error:", err);
    } finally {
        await browser.close();
    }
}

// --- Run ---
// scrapeMultipleFBPosts();
scrapeMultipleFBPosts().then(() => {
    console.log("✅ All scraping, downloading, and analysis finished.");

    // ลบไฟล์ทั้งหมดใน 3 โฟลเดอร์
    const foldersToClean = [
        folderPath, 
        geminiFolder, 
        path.join(__dirname, "downloads")
    ];

    foldersToClean.forEach(folder => {
        if (fs.existsSync(folder)) {
            const files = fs.readdirSync(folder);
            for (const file of files) {
                const filePath = path.join(folder, file);
                try {
                    fs.unlinkSync(filePath);
                    console.log(`🗑 Deleted: ${filePath}`);
                } catch (err) {
                    console.error("❌ Error deleting file:", filePath, err);
                }
            }
        }
    });

    console.log("✅ All files deleted from fbpost, fbgeminitext, and downloads.");
});
