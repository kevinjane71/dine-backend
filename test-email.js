// Test script for email service
require('dotenv').config();
const emailService = require('./emailService');

async function testEmailService() {
  console.log('🧪 Testing Email Service...');
  
  try {
    // Test welcome email
    console.log('📧 Testing welcome email...');
    const welcomeResult = await emailService.sendWelcomeEmail({
      email: 'malik.vk07@gmail.com',
      name: 'Test User'
    });
    console.log('✅ Welcome email test result:', welcomeResult);

    // Test weekly analytics email
    console.log('📊 Testing weekly analytics email...');
    const analyticsResult = await emailService.sendWeeklyAnalyticsReport({
      ownerEmail: 'owner@example.com',
      ownerName: 'Restaurant Owner',
      restaurantName: 'Test Restaurant',
      weekRange: 'Dec 16 - Dec 22',
      totalOrders: 150,
      totalRevenue: 45000,
      averageOrderValue: 300,
      totalCustomers: 120,
      newCustomers: 25,
      orderGrowth: 15.5,
      revenueGrowth: 22.3,
      customerGrowth: 18.7,
      topItems: [
        { name: 'Chicken Biryani', orders: 45, revenue: 13500 },
        { name: 'Butter Chicken', orders: 38, revenue: 11400 },
        { name: 'Naan Bread', orders: 32, revenue: 3200 }
      ],
      busiestHours: [
        { hour: 19, orders: 25 },
        { hour: 20, orders: 22 },
        { hour: 18, orders: 18 }
      ],
      dailyBreakdown: [
        { date: 'Mon Dec 16', orders: 20, revenue: 6000 },
        { date: 'Tue Dec 17', orders: 25, revenue: 7500 },
        { date: 'Wed Dec 18', orders: 22, revenue: 6600 },
        { date: 'Thu Dec 19', orders: 28, revenue: 8400 },
        { date: 'Fri Dec 20', orders: 35, revenue: 10500 },
        { date: 'Sat Dec 21', orders: 30, revenue: 9000 },
        { date: 'Sun Dec 22', orders: 20, revenue: 6000 }
      ]
    });
    console.log('✅ Analytics email test result:', analyticsResult);

    console.log('🎉 All email tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Email test failed:', error);
  }
}

// Run the test
testEmailService();





