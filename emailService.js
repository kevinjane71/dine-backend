const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    console.log('📧 Email Service Debug:');
    console.log('📧 GODADY_EMAIL:', process.env.GODADY_EMAIL ? 'SET' : 'NOT SET');
    console.log('📧 GODADY_PA:', process.env.GODADY_PA ? 'SET' : 'NOT SET');
    
    if (!process.env.GODADY_EMAIL || !process.env.GODADY_PA) {
      console.error('❌ Missing email credentials!');
      console.error('❌ GODADY_EMAIL:', process.env.GODADY_EMAIL);
      console.error('❌ GODADY_PA:', process.env.GODADY_PA ? '[HIDDEN]' : 'NOT SET');
      throw new Error('Missing email credentials');
    }
    
    this.transporter = nodemailer.createTransport({
      host: 'smtpout.secureserver.net',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GODADY_EMAIL,
        pass: process.env.GODADY_PA
      },
      tls: {
        rejectUnauthorized: false
      },
      connectionTimeout: 15000,
      socketTimeout: 15000
    });

    this.templates = {
      // Welcome email for new users
      welcome: {
        subject: 'Welcome to DineOpen - Your AI-Powered Restaurant Management System',
        
        text: (userData) => `
Dear ${userData.name},

Welcome to DineOpen! 🎉

You've made the right choice. Your restaurant is about to become smarter, more efficient, and more profitable.

Get started by setting up your first restaurant and watch your business transform.

Best regards,
The DineOpen Team`,

        html: (userData) => `
<!DOCTYPE html>
<html>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f7fa;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px 20px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 0.5px;">Welcome to DineOpen</h1>
      <p style="color: #fecaca; margin-top: 10px; font-size: 16px;">
        Your AI-Powered Restaurant Management System
      </p>
    </div>

    <!-- Main Content -->
    <div style="padding: 40px 30px;">
      <h2 style="color: #dc2626; margin: 0 0 20px 0; font-size: 24px; font-weight: 600;">
        Dear ${userData.name},
      </h2>
      
      <div style="background: linear-gradient(135deg, #fef2f2 0%, #fef7f7 100%); border-left: 4px solid #dc2626; padding: 25px; border-radius: 8px; margin: 25px 0;">
        <p style="margin: 0; font-size: 18px; color: #374151; font-weight: 500;">
          🎉 <strong>You've made the right choice.</strong>
        </p>
        <p style="margin: 15px 0 0 0; font-size: 16px; color: #6b7280;">
          Your restaurant is about to become smarter, more efficient, and more profitable.
        </p>
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <div style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: white; padding: 15px 30px; border-radius: 25px; display: inline-block; font-weight: 600; font-size: 16px; text-decoration: none; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3);">
          Get Started Now →
        </div>
      </div>

      <p style="text-align: center; margin: 30px 0 0 0; font-size: 14px; color: #9ca3af;">
        Watch your business transform with AI-powered insights and automation.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #F3F4F6; padding: 24px; text-align: center; border-top: 1px solid #E5E7EB;">
      <p style="color: #6B7280; margin: 0; font-size: 14px;">© ${new Date().getFullYear()} DineOpen. AI-Powered Restaurant Management.</p>
      <div style="margin-top: 16px;">
        <a href="https://www.dineopen.com/help" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Help Center</a>
        <a href="https://www.dineopen.com/privacy" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Privacy Policy</a>
        <a href="https://www.dineopen.com/support" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Support</a>
      </div>
    </div>
  </div>
</body>
</html>`
      },

      // Daily AI Insights Report
      aiInsightsReport: {
        getSubject: (ownerName, date) => `Daily Insights Report - ${date}`,

        text: (data) => `
Dear ${data.ownerName},

Here's your AI-powered daily insights report for ${data.date}:

SUMMARY
${data.insights.summary}

${data.insights.performance?.length > 0 ? `PERFORMANCE
${data.insights.performance.map(p => `${p.icon} ${p.title}: ${p.message}`).join('\n')}` : ''}

${data.insights.recommendations?.length > 0 ? `RECOMMENDATIONS
${data.insights.recommendations.map(r => `${r.icon} ${r.title}: ${r.message}${r.action ? ` (Action: ${r.action})` : ''}`).join('\n')}` : ''}

${data.insights.alerts?.length > 0 ? `ALERTS
${data.insights.alerts.map(a => `${a.icon} ${a.title}: ${a.message}`).join('\n')}` : ''}

${data.insights.trends?.length > 0 ? `TRENDS
${data.insights.trends.map(t => `${t.icon} ${t.title}: ${t.message} (${t.value})`).join('\n')}` : ''}

KEY METRICS
- Total Revenue: ${data.analytics.totalRevenue}
- Total Orders: ${data.analytics.totalOrders}
- Average Order Value: ${data.analytics.avgOrderValue}
- Restaurants: ${data.restaurantCount}

View your full dashboard at https://www.dineopen.com/headquarters

Best regards,
DineOpen AI Analytics
        `,

        html: (data) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f7fa;">
  <div style="max-width: 640px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px 30px; text-align: center; position: relative;">
      <div style="position: relative; z-index: 1;">
        <div style="width: 60px; height: 60px; background: rgba(255,255,255,0.2); border-radius: 16px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 28px;">🤖</span>
        </div>
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700;">Daily Insights Report</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 14px;">
          ${data.date}
        </p>
      </div>
    </div>

    <!-- Greeting -->
    <div style="padding: 30px 30px 0;">
      <p style="font-size: 18px; color: #1f2937; margin: 0;">
        Good morning, <strong>${data.ownerName}</strong>! 👋
      </p>
    </div>

    <!-- Summary Card -->
    <div style="padding: 20px 30px;">
      <div style="background: linear-gradient(135deg, #fef2f2 0%, #fff1f2 100%); border-left: 4px solid #ef4444; padding: 20px 24px; border-radius: 12px;">
        <p style="margin: 0; font-size: 16px; color: #374151; line-height: 1.7;">
          ${data.insights.summary}
        </p>
      </div>
    </div>

    <!-- Quick Stats Grid -->
    <div style="padding: 0 30px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: separate; border-spacing: 12px 0;">
        <tr>
          <td style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 12px; text-align: center; width: 25%;">
            <div style="font-size: 24px; font-weight: 700; margin-bottom: 4px;">₹${typeof data.analytics.totalRevenue === 'number' ? data.analytics.totalRevenue.toLocaleString() : data.analytics.totalRevenue}</div>
            <div style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Revenue</div>
          </td>
          <td style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 12px; text-align: center; width: 25%;">
            <div style="font-size: 24px; font-weight: 700; margin-bottom: 4px;">${data.analytics.totalOrders}</div>
            <div style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Orders</div>
          </td>
          <td style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 20px; border-radius: 12px; text-align: center; width: 25%;">
            <div style="font-size: 24px; font-weight: 700; margin-bottom: 4px;">₹${typeof data.analytics.avgOrderValue === 'number' ? Math.round(data.analytics.avgOrderValue) : data.analytics.avgOrderValue}</div>
            <div style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Avg Order</div>
          </td>
          <td style="background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 20px; border-radius: 12px; text-align: center; width: 25%;">
            <div style="font-size: 24px; font-weight: 700; margin-bottom: 4px;">${data.restaurantCount}</div>
            <div style="font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">Locations</div>
          </td>
        </tr>
      </table>
    </div>

    ${data.insights.alerts?.length > 0 ? `
    <!-- Alerts Section -->
    <div style="padding: 0 30px 20px;">
      <h3 style="font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">
        ⚡ Requires Attention
      </h3>
      ${data.insights.alerts.map(alert => `
        <div style="background: ${alert.severity === 'critical' ? 'linear-gradient(135deg, #fee2e2, #fecaca)' : 'linear-gradient(135deg, #fef3c7, #fde68a)'}; border-radius: 12px; padding: 16px 20px; margin-bottom: 10px; display: flex; align-items: flex-start;">
          <span style="font-size: 24px; margin-right: 14px;">${alert.icon}</span>
          <div>
            <div style="font-size: 15px; font-weight: 600; color: ${alert.severity === 'critical' ? '#dc2626' : '#d97706'}; margin-bottom: 4px;">${alert.title}</div>
            <div style="font-size: 14px; color: #4b5563;">${alert.message}</div>
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${data.insights.performance?.length > 0 ? `
    <!-- Performance Section -->
    <div style="padding: 0 30px 20px;">
      <h3 style="font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">
        📊 Performance Highlights
      </h3>
      ${data.insights.performance.map(item => `
        <div style="background: #f9fafb; border-radius: 12px; padding: 14px 18px; margin-bottom: 8px; display: flex; align-items: center;">
          <span style="font-size: 22px; margin-right: 14px;">${item.icon}</span>
          <div style="flex: 1;">
            <div style="font-size: 14px; font-weight: 600; color: #1f2937;">${item.title}</div>
            <div style="font-size: 13px; color: #6b7280;">${item.message}</div>
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${data.insights.recommendations?.length > 0 ? `
    <!-- Recommendations Section -->
    <div style="padding: 0 30px 20px;">
      <h3 style="font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">
        💡 AI Recommendations
      </h3>
      ${data.insights.recommendations.map(rec => `
        <div style="background: ${rec.priority === 'high' ? '#fef2f2' : rec.priority === 'medium' ? '#fffbeb' : '#f0fdf4'}; border-left: 4px solid ${rec.priority === 'high' ? '#ef4444' : rec.priority === 'medium' ? '#f59e0b' : '#22c55e'}; border-radius: 0 12px 12px 0; padding: 16px 20px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 20px; margin-right: 10px;">${rec.icon}</span>
            <span style="font-size: 15px; font-weight: 600; color: #1f2937;">${rec.title}</span>
            <span style="margin-left: auto; font-size: 11px; padding: 3px 8px; background: ${rec.priority === 'high' ? '#ef4444' : rec.priority === 'medium' ? '#f59e0b' : '#22c55e'}; color: white; border-radius: 10px; text-transform: uppercase;">${rec.priority}</span>
          </div>
          <p style="font-size: 14px; color: #4b5563; margin: 0 0 10px;">${rec.message}</p>
          ${rec.action ? `
          <div style="display: flex; align-items: center; color: #ef4444; font-size: 13px; font-weight: 500;">
            <span style="margin-right: 6px;">→</span> ${rec.action}
          </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${data.insights.trends?.length > 0 ? `
    <!-- Trends Section -->
    <div style="padding: 0 30px 20px;">
      <h3 style="font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">
        📈 Trends
      </h3>
      ${data.insights.trends.map(trend => `
        <div style="background: #f9fafb; border-radius: 12px; padding: 14px 18px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center;">
            <span style="font-size: 22px; margin-right: 14px;">${trend.icon}</span>
            <div>
              <div style="font-size: 14px; font-weight: 600; color: #1f2937;">${trend.title}</div>
              <div style="font-size: 12px; color: #6b7280;">${trend.message}</div>
            </div>
          </div>
          <div style="padding: 6px 14px; border-radius: 20px; background: ${trend.direction === 'up' ? '#dcfce7' : trend.direction === 'down' ? '#fee2e2' : '#f1f5f9'}; color: ${trend.direction === 'up' ? '#16a34a' : trend.direction === 'down' ? '#dc2626' : '#6b7280'}; font-size: 14px; font-weight: 700;">
            ${trend.value}
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${data.insights.pricingInsights?.length > 0 ? `
    <!-- Pricing Insights -->
    <div style="padding: 0 30px 20px;">
      <h3 style="font-size: 14px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">
        💰 Pricing Insights
      </h3>
      ${data.insights.pricingInsights.map(item => `
        <div style="background: linear-gradient(135deg, #fefce8, #fef9c3); border-radius: 12px; padding: 14px 18px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 18px; margin-right: 10px;">${item.icon}</span>
            <span style="font-size: 14px; font-weight: 600; color: #1f2937;">${item.title}</span>
          </div>
          <div style="font-size: 13px; color: #6b7280;">${item.message}</div>
        </div>
      `).join('')}
    </div>
    ` : ''}

    <!-- CTA Button -->
    <div style="padding: 10px 30px 30px; text-align: center;">
      <a href="https://www.dineopen.com/headquarters" target="_blank"
         style="display: inline-block; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);">
        View Full Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="background: linear-gradient(135deg, #f8fafc, #f1f5f9); padding: 24px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
      <p style="color: #6b7280; margin: 0 0 8px; font-size: 13px;">
        This report was generated by DineOpen AI using rule-based analysis of your restaurant data.
      </p>
      <p style="color: #9ca3af; margin: 0 0 16px; font-size: 12px;">
        No data was sent to external AI services. Your data stays secure on our servers.
      </p>
      <div style="margin-top: 16px;">
        <a href="https://www.dineopen.com/headquarters" style="color: #ef4444; text-decoration: none; margin: 0 12px; font-size: 13px;">Dashboard</a>
        <a href="https://www.dineopen.com/help" style="color: #ef4444; text-decoration: none; margin: 0 12px; font-size: 13px;">Help</a>
        <a href="https://www.dineopen.com/settings/notifications" style="color: #ef4444; text-decoration: none; margin: 0 12px; font-size: 13px;">Unsubscribe</a>
      </div>
      <p style="color: #9ca3af; margin: 16px 0 0; font-size: 11px;">© ${new Date().getFullYear()} DineOpen. AI-Powered Restaurant Management.</p>
    </div>
  </div>
</body>
</html>
        `
      },

      // Weekly analytics report
      weeklyAnalytics: {
        getSubject: (restaurantName, weekRange) => `Weekly Analytics Report - ${restaurantName} (${weekRange})`,
        
        text: (analyticsData) => `
Dear ${analyticsData.ownerName},

Here's your weekly analytics report for ${analyticsData.restaurantName}:

📊 WEEKLY SUMMARY
- Total Orders: ${analyticsData.totalOrders}
- Total Revenue: ₹${analyticsData.totalRevenue}
- Average Order Value: ₹${analyticsData.averageOrderValue}
- Total Customers: ${analyticsData.totalCustomers}
- New Customers: ${analyticsData.newCustomers}

🍽️ TOP PERFORMING ITEMS
${analyticsData.topItems.map((item, index) => `${index + 1}. ${item.name} - ${item.orders} orders (₹${item.revenue})`).join('\n')}

📈 GROWTH METRICS
- Revenue Growth: ${analyticsData.revenueGrowth > 0 ? '+' : ''}${analyticsData.revenueGrowth}%
- Order Growth: ${analyticsData.orderGrowth > 0 ? '+' : ''}${analyticsData.orderGrowth}%
- Customer Growth: ${analyticsData.customerGrowth > 0 ? '+' : ''}${analyticsData.customerGrowth}%

🕒 BUSIEST HOURS
${analyticsData.busiestHours.map(hour => `${hour.hour}:00 - ${hour.orders} orders`).join('\n')}

📅 WEEKLY BREAKDOWN
${analyticsData.dailyBreakdown.map(day => `${day.date}: ${day.orders} orders, ₹${day.revenue}`).join('\n')}

Best regards,
DineOpen Analytics Team`,

        html: (analyticsData) => `
<!DOCTYPE html>
<html>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f7fa;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px 20px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 0.5px;">Weekly Analytics Report</h1>
      <p style="color: #fecaca; margin-top: 10px; font-size: 16px;">
        ${analyticsData.restaurantName} - ${analyticsData.weekRange}
      </p>
    </div>

    <!-- Main Content -->
    <div style="padding: 32px 24px; background-color: #ffffff;">
      <p style="font-size: 16px; color: #4B5563; margin-top: 0;">Dear ${analyticsData.ownerName},</p>
      
      <p style="font-size: 16px; color: #4B5563; margin-bottom: 24px;">
        Here's your comprehensive weekly analytics report for <strong>${analyticsData.restaurantName}</strong>:
      </p>

      <!-- Summary Cards -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 16px; margin-bottom: 32px;">
        <div style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">${analyticsData.totalOrders}</div>
          <div style="font-size: 12px; opacity: 0.9;">Total Orders</div>
        </div>
        <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">₹${analyticsData.totalRevenue}</div>
          <div style="font-size: 12px; opacity: 0.9;">Total Revenue</div>
        </div>
        <div style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">₹${analyticsData.averageOrderValue}</div>
          <div style="font-size: 12px; opacity: 0.9;">Avg Order Value</div>
        </div>
        <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white; padding: 20px; border-radius: 8px; text-align: center;">
          <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">${analyticsData.totalCustomers}</div>
          <div style="font-size: 12px; opacity: 0.9;">Total Customers</div>
        </div>
      </div>

      <!-- Top Items -->
      <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #111827; font-size: 18px;">🍽️ Top Performing Items</h3>
        ${analyticsData.topItems.map((item, index) => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
            <div style="display: flex; align-items: center;">
              <span style="background: #ef4444; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; margin-right: 12px;">${index + 1}</span>
              <span style="font-weight: 500; color: #111827;">${item.name}</span>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 14px; color: #6b7280;">${item.orders} orders</div>
              <div style="font-size: 14px; font-weight: 600; color: #10b981;">₹${item.revenue}</div>
            </div>
          </div>
        `).join('')}
      </div>

      <!-- Growth Metrics -->
      <div style="background-color: #f0f9ff; border: 1px solid #0ea5e9; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #111827; font-size: 18px;">📈 Growth Metrics</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px;">
          <div style="text-align: center;">
            <div style="font-size: 20px; font-weight: bold; color: ${analyticsData.revenueGrowth >= 0 ? '#10b981' : '#ef4444'};">
              ${analyticsData.revenueGrowth > 0 ? '+' : ''}${analyticsData.revenueGrowth}%
            </div>
            <div style="font-size: 12px; color: #6b7280;">Revenue Growth</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 20px; font-weight: bold; color: ${analyticsData.orderGrowth >= 0 ? '#10b981' : '#ef4444'};">
              ${analyticsData.orderGrowth > 0 ? '+' : ''}${analyticsData.orderGrowth}%
            </div>
            <div style="font-size: 12px; color: #6b7280;">Order Growth</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 20px; font-weight: bold; color: ${analyticsData.customerGrowth >= 0 ? '#10b981' : '#ef4444'};">
              ${analyticsData.customerGrowth > 0 ? '+' : ''}${analyticsData.customerGrowth}%
            </div>
            <div style="font-size: 12px; color: #6b7280;">Customer Growth</div>
          </div>
        </div>
      </div>

      <!-- Busiest Hours -->
      <div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #111827; font-size: 18px;">🕒 Busiest Hours</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;">
          ${analyticsData.busiestHours.map(hour => `
            <div style="text-align: center; padding: 8px; background: white; border-radius: 6px;">
              <div style="font-size: 14px; font-weight: 600; color: #111827;">${hour.hour}:00</div>
              <div style="font-size: 12px; color: #6b7280;">${hour.orders} orders</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Daily Breakdown -->
      <div style="background-color: #f3f4f6; border: 1px solid #d1d5db; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #111827; font-size: 18px;">📅 Weekly Breakdown</h3>
        ${analyticsData.dailyBreakdown.map(day => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
            <span style="font-weight: 500; color: #111827;">${day.date}</span>
            <div style="text-align: right;">
              <span style="font-size: 14px; color: #6b7280; margin-right: 16px;">${day.orders} orders</span>
              <span style="font-size: 14px; font-weight: 600; color: #10b981;">₹${day.revenue}</span>
            </div>
          </div>
        `).join('')}
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="https://www.dineopen.com/dashboard" target="_blank" 
           style="display: inline-block; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
          View Detailed Analytics
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #F3F4F6; padding: 24px; text-align: center; border-top: 1px solid #E5E7EB;">
      <p style="color: #6B7280; margin: 0; font-size: 14px;">© ${new Date().getFullYear()} DineOpen. AI-Powered Restaurant Management.</p>
      <div style="margin-top: 16px;">
        <a href="https://www.dineopen.com/analytics" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Analytics Dashboard</a>
        <a href="https://www.dineopen.com/help" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Help Center</a>
        <a href="https://www.dineopen.com/support" style="color: #ef4444; text-decoration: none; margin: 0 8px; font-size: 14px;">Support</a>
      </div>
    </div>
  </div>
</body>
</html>`
      }
    };
  }

  async sendEmail({ to, subject, text, html, attachments = [] }) {
    try {
      const mailOptions = {
        from: process.env.GODADY_EMAIL || "noreply@dineopen.com",
        to,
        subject,
        text,
        html,
        attachments
      };
      
      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Email send error:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  // Send welcome email to new users
  async sendWelcomeEmail(userData) {
    console.log('📧 Sending welcome email to:', userData.email);
    
    if (!userData.email || !userData.name) {
      throw new Error('Email and name are required for welcome email');
    }

    const template = this.templates.welcome;
    return this.sendEmail({
      to: userData.email,
      subject: template.subject,
      text: template.text(userData),
      html: template.html(userData)
    });
  }

  // Send AI Insights daily report email
  async sendAIInsightsReport(reportData) {
    console.log('🤖 Sending AI Insights report to:', reportData.ownerEmail);

    if (!reportData.ownerEmail || !reportData.ownerName) {
      throw new Error('Owner email and name are required for AI insights report');
    }

    const template = this.templates.aiInsightsReport;
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const data = {
      ...reportData,
      date: today
    };

    return this.sendEmail({
      to: reportData.ownerEmail,
      subject: template.getSubject(reportData.ownerName, today),
      text: template.text(data),
      html: template.html(data)
    });
  }

  // Send weekly analytics report to restaurant owners
  async sendWeeklyAnalyticsReport(analyticsData) {
    console.log('📊 Sending weekly analytics report to:', analyticsData.ownerEmail);
    
    if (!analyticsData.ownerEmail || !analyticsData.ownerName || !analyticsData.restaurantName) {
      throw new Error('Owner email, name, and restaurant name are required for analytics report');
    }

    const template = this.templates.weeklyAnalytics;
    return this.sendEmail({
      to: analyticsData.ownerEmail,
      subject: template.getSubject(analyticsData.restaurantName, analyticsData.weekRange),
      text: template.text(analyticsData),
      html: template.html(analyticsData)
    });
  }

  // Send purchase order email to supplier
  async sendPurchaseOrderEmail(emailData) {
    console.log('📦 Sending purchase order email to:', emailData.to);
    
    if (!emailData.to || !emailData.supplierName || !emailData.restaurantName) {
      throw new Error('Supplier email, name, and restaurant name are required for purchase order email');
    }

    const subject = `Purchase Order #${emailData.orderNumber} from ${emailData.restaurantName}`;
    
    const textContent = `
Dear ${emailData.supplierName},

We are pleased to place the following purchase order with your company:

Order Number: ${emailData.orderNumber}
Restaurant: ${emailData.restaurantName}
Order Date: ${new Date(emailData.orderData.createdAt).toLocaleDateString()}
Expected Delivery: ${emailData.orderData.expectedDeliveryDate ? new Date(emailData.orderData.expectedDeliveryDate).toLocaleDateString() : 'Not specified'}

Items Ordered:
${emailData.orderData.items.map(item => `- ${item.inventoryItemName}: ${item.quantity} units @ ₹${item.unitPrice} each`).join('\n')}

Total Amount: ₹${emailData.orderData.totalAmount}

${emailData.orderData.notes ? `Notes: ${emailData.orderData.notes}` : ''}

Please confirm receipt of this order and provide delivery details.

Thank you for your business.

Best regards,
${emailData.restaurantName}
    `;

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #059669; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
        .order-details { background-color: white; padding: 15px; border-radius: 5px; margin: 15px 0; }
        .items-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        .items-table th, .items-table td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        .items-table th { background-color: #059669; color: white; }
        .total { font-weight: bold; font-size: 18px; color: #059669; text-align: right; margin-top: 15px; }
        .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Purchase Order</h1>
        <p>Order #${emailData.orderNumber}</p>
      </div>
      
      <div class="content">
        <p>Dear ${emailData.supplierName},</p>
        
        <p>We are pleased to place the following purchase order with your company:</p>
        
        <div class="order-details">
          <p><strong>Order Number:</strong> ${emailData.orderNumber}</p>
          <p><strong>Restaurant:</strong> ${emailData.restaurantName}</p>
          <p><strong>Order Date:</strong> ${new Date(emailData.orderData.createdAt).toLocaleDateString()}</p>
          <p><strong>Expected Delivery:</strong> ${emailData.orderData.expectedDeliveryDate ? new Date(emailData.orderData.expectedDeliveryDate).toLocaleDateString() : 'Not specified'}</p>
        </div>

        <h3>Items Ordered:</h3>
        <table class="items-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Quantity</th>
              <th>Unit Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${emailData.orderData.items.map(item => `
              <tr>
                <td>${item.inventoryItemName}</td>
                <td>${item.quantity}</td>
                <td>₹${item.unitPrice}</td>
                <td>₹${(item.quantity * item.unitPrice).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="total">
          Total Amount: ₹${emailData.orderData.totalAmount}
        </div>

        ${emailData.orderData.notes ? `
          <div class="order-details">
            <h4>Notes:</h4>
            <p>${emailData.orderData.notes}</p>
          </div>
        ` : ''}

        <p>Please confirm receipt of this order and provide delivery details.</p>
        
        <p>Thank you for your business.</p>
        
        <p>Best regards,<br>
        <strong>${emailData.restaurantName}</strong></p>
      </div>
      
      <div class="footer">
        <p>This is an automated email from DineOpen Restaurant Management System.</p>
        <p>Please find the detailed purchase order invoice attached.</p>
      </div>
    </body>
    </html>
    `;

    try {
      const result = await this.sendEmail({
        to: emailData.to,
        subject: subject,
        text: textContent,
        html: htmlContent,
        attachments: [{
          filename: `Purchase_Order_${emailData.orderNumber}.html`,
          content: emailData.invoiceHtml,
          contentType: 'text/html'
        }]
      });

      return {
        success: true,
        emailId: result.messageId,
        message: 'Purchase order email sent successfully'
      };
    } catch (error) {
      console.error('Error sending purchase order email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Helper method to format dates
  formatDate(date) {
    if (!date) return '';
    try {
      return new Date(date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (error) {
      console.error('Date formatting error:', error);
      return date.toString();
    }
  }

  // Helper method to format currency
  formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  }

  // Send demo request notification email
  async sendDemoRequestNotification(demoData) {
    console.log('📧 Sending demo request notification email');
    
    // Hardcoded email addresses to receive demo request notifications
    const adminEmails = 'malik.vk07@gmail.com,dineopen007@gmail.com';

    const subject = `🎯 New Demo Request - ${demoData.restaurantName || 'Restaurant'}`;
    
    const textContent = `
New Demo Request Received

Contact Type: ${demoData.contactType}
${demoData.phone ? `Phone: ${demoData.phone}` : ''}
${demoData.email ? `Email: ${demoData.email}` : ''}
Restaurant Name: ${demoData.restaurantName || 'Not provided'}
Comment: ${demoData.comment || 'No additional comments'}

Request ID: ${demoData.id}
Submitted At: ${new Date(demoData.createdAt).toLocaleString()}
IP Address: ${demoData.ipAddress || 'Not available'}
User Agent: ${demoData.userAgent || 'Not available'}

Please follow up with the potential customer as soon as possible.
    `;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f7fa; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); }
    .header { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 40px 20px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 0.5px; }
    .header p { color: #fecaca; margin-top: 10px; font-size: 16px; }
    .content { padding: 40px 30px; }
    .info-card { background: linear-gradient(135deg, #fef2f2 0%, #fef7f7 100%); border-left: 4px solid #dc2626; padding: 25px; border-radius: 8px; margin: 20px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-weight: 600; color: #374151; min-width: 150px; }
    .info-value { color: #6b7280; flex: 1; text-align: right; }
    .highlight { background-color: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b; }
    .footer { background-color: #F3F4F6; padding: 24px; text-align: center; border-top: 1px solid #E5E7EB; }
    .footer p { color: #6B7280; margin: 0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎯 New Demo Request</h1>
      <p>Someone has requested a demo of DineOpen</p>
    </div>
    
    <div class="content">
      <div class="info-card">
        <h2 style="color: #dc2626; margin: 0 0 20px 0; font-size: 20px;">Contact Information</h2>
        <div class="info-row">
          <span class="info-label">Contact Type:</span>
          <span class="info-value">${demoData.contactType === 'phone' ? '📞 Phone' : '📧 Email'}</span>
        </div>
        ${demoData.phone ? `
        <div class="info-row">
          <span class="info-label">Phone Number:</span>
          <span class="info-value"><a href="tel:${demoData.phone}" style="color: #ef4444; text-decoration: none;">${demoData.phone}</a></span>
        </div>
        ` : ''}
        ${demoData.email ? `
        <div class="info-row">
          <span class="info-label">Email Address:</span>
          <span class="info-value"><a href="mailto:${demoData.email}" style="color: #ef4444; text-decoration: none;">${demoData.email}</a></span>
        </div>
        ` : ''}
        <div class="info-row">
          <span class="info-label">Restaurant Name:</span>
          <span class="info-value"><strong>${demoData.restaurantName || 'Not provided'}</strong></span>
        </div>
      </div>

      ${demoData.comment ? `
      <div class="highlight">
        <h3 style="margin: 0 0 10px 0; color: #92400e; font-size: 16px;">💬 Additional Comments:</h3>
        <p style="margin: 0; color: #78350f; white-space: pre-wrap;">${demoData.comment}</p>
      </div>
      ` : ''}

      <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin-top: 20px;">
        <h3 style="margin: 0 0 15px 0; color: #111827; font-size: 16px;">📋 Request Details</h3>
        <div class="info-row">
          <span class="info-label">Request ID:</span>
          <span class="info-value" style="font-family: monospace; font-size: 12px;">${demoData.id}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Submitted At:</span>
          <span class="info-value">${new Date(demoData.createdAt).toLocaleString()}</span>
        </div>
        ${demoData.ipAddress ? `
        <div class="info-row">
          <span class="info-label">IP Address:</span>
          <span class="info-value" style="font-family: monospace; font-size: 12px;">${demoData.ipAddress}</span>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <div style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: white; padding: 15px 30px; border-radius: 25px; display: inline-block; font-weight: 600; font-size: 16px;">
          ⚡ Please follow up as soon as possible
        </div>
      </div>
    </div>

    <div class="footer">
      <p>© ${new Date().getFullYear()} DineOpen. AI-Powered Restaurant Management.</p>
      <p style="margin-top: 8px; font-size: 12px;">This is an automated notification from the DineOpen demo request system.</p>
    </div>
  </div>
</body>
</html>
    `;

    try {
      const result = await this.sendEmail({
        to: adminEmails,
        subject: subject,
        text: textContent,
        html: htmlContent
      });

      console.log('✅ Demo request notification sent to:', adminEmails);
      return {
        success: true,
        emailId: result.messageId,
        message: 'Demo request notification email sent successfully'
      };
    } catch (error) {
      console.error('Error sending demo request notification email:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new EmailService();
