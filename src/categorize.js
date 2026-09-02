/**
 * Sorts messages into buckets.
 *
 * Gmail's own tab labels win when present, because Google already did the hard part.
 * Everything else falls through to the sender/subject rules below, which are plain data —
 * add a domain to `senders` and it takes effect on the next refresh.
 */

export const CATEGORIES = [
  'Personal',
  'Work',
  'Finance',
  'Shopping',
  'Newsletters',
  'Social',
  'Other',
];

const RULES = [
  {
    category: 'Finance',
    senders: [
      'bank', 'hdfc', 'icici', 'sbi', 'axis', 'kotak', 'paytm', 'phonepe',
      'razorpay', 'stripe', 'paypal', 'billing', 'invoice', 'payments',
      'zerodha', 'groww', 'upstox', 'creditcard',
    ],
    subjects: [
      'invoice', 'receipt', 'payment', 'transaction', 'statement', 'refund',
      'credited', 'debited', 'due date', 'emi', 'salary',
    ],
  },
  {
    category: 'Shopping',
    senders: [
      'amazon', 'flipkart', 'myntra', 'ajio', 'swiggy', 'zomato', 'bigbasket',
      'nykaa', 'meesho', 'shopify', 'order', 'delivery',
    ],
    subjects: ['your order', 'shipped', 'out for delivery', 'delivered', 'cart', 'tracking'],
  },
  {
    category: 'Work',
    senders: [
      'jira', 'atlassian', 'github', 'gitlab', 'slack', 'notion', 'asana',
      'linear', 'zoom', 'teams', 'workspace', 'linkedin', 'naukri', 'indeed',
      'greenhouse', 'lever',
    ],
    subjects: [
      'meeting', 'standup', 'sprint', 'deadline', 'review', 'interview',
      'offer letter', 'pull request', 'merge request', 'ticket', 'deploy',
    ],
  },
  {
    category: 'Newsletters',
    senders: [
      'newsletter', 'substack', 'medium', 'digest', 'noreply', 'no-reply',
      'updates@', 'news@', 'mailer', 'marketing', 'campaign',
    ],
    subjects: ['newsletter', 'weekly digest', 'this week in', 'unsubscribe', 'issue #'],
  },
  {
    category: 'Social',
    senders: [
      'facebook', 'instagram', 'twitter', 'x.com', 'reddit', 'quora',
      'discord', 'pinterest', 'snapchat', 'youtube', 'whatsapp',
    ],
    subjects: ['tagged you', 'commented on', 'mentioned you', 'new follower', 'friend request'],
  },
];

export function categorize({ fromEmail = '', subject = '', labelIds = [] }) {
  if (labelIds.includes('CATEGORY_SOCIAL')) return 'Social';
  if (labelIds.includes('CATEGORY_PROMOTIONS')) return 'Newsletters';
  if (labelIds.includes('CATEGORY_FORUMS')) return 'Newsletters';

  const sender = fromEmail.toLowerCase();
  const subj = subject.toLowerCase();

  for (const rule of RULES) {
    if (rule.senders.some((needle) => sender.includes(needle))) return rule.category;
    if (rule.subjects.some((needle) => subj.includes(needle))) return rule.category;
  }

  if (labelIds.includes('CATEGORY_PERSONAL')) return 'Personal';
  return 'Other';
}
