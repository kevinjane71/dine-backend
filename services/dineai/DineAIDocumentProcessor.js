/**
 * DineAI Document Processor
 * Handles parsing and processing of various document types
 */

const OpenAI = require('openai');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');

class DineAIDocumentProcessor {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.supportedTypes = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-excel': 'xls',
      'text/plain': 'txt',
      'text/csv': 'csv',
      'image/jpeg': 'image',
      'image/png': 'image',
      'image/webp': 'image'
    };
  }

  /**
   * Get file type from mimetype
   */
  getFileType(mimetype) {
    return this.supportedTypes[mimetype] || null;
  }

  /**
   * Check if file type is supported
   */
  isSupported(mimetype) {
    return !!this.supportedTypes[mimetype];
  }

  /**
   * Process a document and extract text
   */
  async processDocument(file, options = {}) {
    const fileType = this.getFileType(file.mimetype);

    if (!fileType) {
      throw new Error(`Unsupported file type: ${file.mimetype}`);
    }

    let text = '';
    let metadata = {};

    switch (fileType) {
      case 'pdf':
        const pdfResult = await this.processPDF(file.buffer);
        text = pdfResult.text;
        metadata = pdfResult.metadata;
        break;

      case 'docx':
      case 'doc':
        text = await this.processWord(file.buffer);
        break;

      case 'xlsx':
      case 'xls':
        text = await this.processExcel(file.buffer);
        break;

      case 'txt':
        text = file.buffer.toString('utf-8');
        break;

      case 'csv':
        text = await this.processCSV(file.buffer);
        break;

      case 'image':
        text = await this.processImage(file.buffer, file.mimetype);
        break;

      default:
        throw new Error(`Processing not implemented for: ${fileType}`);
    }

    // Clean and normalize text
    text = this.cleanText(text);

    return {
      text,
      metadata,
      fileType,
      characterCount: text.length,
      wordCount: text.split(/\s+/).length
    };
  }

  /**
   * Process PDF file
   */
  async processPDF(buffer) {
    try {
      const data = await pdf(buffer);

      return {
        text: data.text,
        metadata: {
          pages: data.numpages,
          info: data.info
        }
      };
    } catch (error) {
      console.error('PDF processing error:', error);
      throw new Error('Failed to process PDF file');
    }
  }

  /**
   * Process Word document
   */
  async processWord(buffer) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error) {
      console.error('Word processing error:', error);
      throw new Error('Failed to process Word document');
    }
  }

  /**
   * Process Excel file
   */
  async processExcel(buffer) {
    try {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      let text = '';

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

        text += `\n## Sheet: ${sheetName}\n`;

        for (const row of data) {
          if (row && row.length > 0) {
            text += row.join(' | ') + '\n';
          }
        }
      }

      return text;
    } catch (error) {
      console.error('Excel processing error:', error);
      throw new Error('Failed to process Excel file');
    }
  }

  /**
   * Process CSV file
   */
  async processCSV(buffer) {
    try {
      const content = buffer.toString('utf-8');
      const lines = content.split('\n');

      // Convert CSV to readable text
      let text = '';

      if (lines.length > 0) {
        const headers = lines[0].split(',').map(h => h.trim());

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());

          if (values.length === headers.length) {
            const row = headers.map((h, idx) => `${h}: ${values[idx]}`).join(', ');
            text += row + '\n';
          }
        }
      }

      return text || content;
    } catch (error) {
      console.error('CSV processing error:', error);
      throw new Error('Failed to process CSV file');
    }
  }

  /**
   * Process image using GPT-4 Vision
   */
  async processImage(buffer, mimetype) {
    try {
      const base64Image = buffer.toString('base64');
      const dataUri = `data:${mimetype};base64,${base64Image}`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Extract all text and information from this image. If it's a menu, list all items with prices. If it's a document, extract the full text content. If it contains policies or procedures, extract them clearly. Format the output as plain text.`
              },
              {
                type: 'image_url',
                image_url: {
                  url: dataUri,
                  detail: 'high'
                }
              }
            ]
          }
        ],
        max_tokens: 4000
      });

      return response.choices[0].message.content || '';
    } catch (error) {
      console.error('Image processing error:', error);
      throw new Error('Failed to process image');
    }
  }

  /**
   * Process URL content
   */
  async processURL(url) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      // If HTML, extract text content
      if (contentType.includes('text/html')) {
        return this.extractTextFromHTML(text);
      }

      return text;
    } catch (error) {
      console.error('URL processing error:', error);
      throw new Error(`Failed to process URL: ${error.message}`);
    }
  }

  /**
   * Extract text from HTML
   */
  extractTextFromHTML(html) {
    // Simple HTML to text conversion
    let text = html
      // Remove scripts and styles
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Replace common block elements with newlines
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove all remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return this.cleanText(text);
  }

  /**
   * Clean and normalize text
   */
  cleanText(text) {
    return text
      // Normalize whitespace
      .replace(/[\t ]+/g, ' ')
      // Normalize newlines
      .replace(/\n{3,}/g, '\n\n')
      // Remove leading/trailing whitespace from lines
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      // Remove leading/trailing whitespace
      .trim();
  }

  /**
   * Detect document category from content
   */
  async detectCategory(text) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Classify the following document into one category: faq, policy, menu, procedure, or general. Respond with only the category name.'
          },
          {
            role: 'user',
            content: text.substring(0, 2000) // First 2000 chars for classification
          }
        ],
        max_tokens: 10
      });

      const category = response.choices[0].message.content?.toLowerCase().trim();

      if (['faq', 'policy', 'menu', 'procedure', 'general'].includes(category)) {
        return category;
      }

      return 'general';
    } catch (error) {
      console.error('Category detection error:', error);
      return 'general';
    }
  }

  /**
   * Extract title from content
   */
  extractTitle(text, filename) {
    // Try to get title from first line if it looks like a heading
    const firstLine = text.split('\n')[0]?.trim() || '';

    if (firstLine.length > 0 && firstLine.length < 100 && !firstLine.includes('.')) {
      return firstLine;
    }

    // Fall back to filename
    const name = filename.replace(/\.[^.]+$/, ''); // Remove extension
    return name.replace(/[_-]/g, ' '); // Replace underscores/hyphens with spaces
  }

  /**
   * Generate tags for content
   */
  async generateTags(text) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Generate 3-5 relevant tags for the following content. Respond with only the tags separated by commas.'
          },
          {
            role: 'user',
            content: text.substring(0, 1500)
          }
        ],
        max_tokens: 50
      });

      const tagsString = response.choices[0].message.content || '';
      return tagsString
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(tag => tag.length > 0);
    } catch (error) {
      console.error('Tag generation error:', error);
      return [];
    }
  }

  /**
   * Process and prepare document for knowledge base
   */
  async prepareForKnowledgeBase(file, restaurantId) {
    // Process the document
    const processed = await this.processDocument(file);

    // Detect category
    const category = await this.detectCategory(processed.text);

    // Extract title
    const title = this.extractTitle(processed.text, file.originalname || 'document');

    // Generate tags
    const tags = await this.generateTags(processed.text);

    return {
      id: `${file.originalname || 'doc'}_${Date.now()}`,
      restaurantId,
      title,
      content: processed.text,
      type: processed.fileType,
      category,
      source: file.originalname || 'uploaded',
      tags,
      metadata: {
        ...processed.metadata,
        characterCount: processed.characterCount,
        wordCount: processed.wordCount,
        originalFilename: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      }
    };
  }
}

module.exports = new DineAIDocumentProcessor();
