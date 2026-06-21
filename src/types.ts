export interface User {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  is_admin: number;
  is_super_admin: number;
  telegram_id: string | null;
  telegram_username: string | null;
  created_at: string;
}

export interface Tournament {
  id: number;
  name: string;
  description: string | null;
  platform: string;
  format: 'knockout' | 'league' | 'multi_bracket' | 'swiss';
  max_players: number;
  best_of: number;
  status: 'draft' | 'registration_open' | 'check_in' | 'in_progress' | 'completed' | 'cancelled';
  owner_id: number;
  winner_id: number | null;
  prize_pool: string | null;
  registration_deadline: string | null;
  result_deadline_hours: number;
  rules: string | null;
  group_count: number;
  bracket_type: string;
  image_url: string | null;
  entry_fee: number;
  is_private: number;
  created_at: string;
}

export interface Participant {
  id: number;
  tournament_id: number;
  user_id: number;
  status: 'registered' | 'checked_in' | 'eliminated' | 'winner';
  seed: number | null;
  team_name: string | null;
  team_logo_url: string | null;
  joined_at: string;
}

export interface Match {
  id: number;
  tournament_id: number;
  round: number;
  match_number: number;
  player1_id: number | null;
  player2_id: number | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_id: number | null;
  status: 'pending' | 'in_progress' | 'completed' | 'disputed' | 'cancelled';
  player1_team: string | null;
  player2_team: string | null;
  screenshot_url: string | null;
  opponent_screenshot_url: string | null;
  verification_status: 'none' | 'pending' | 'verified' | 'rejected';
  submitted_by: number | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface ResultSubmission {
  id: number;
  match_id: number;
  uploader_id: number;
  screenshot_url: string | null;
  screenshot_hash: string | null;
  ocr_team_left: string | null;
  ocr_team_right: string | null;
  ocr_score_left: number | null;
  ocr_score_right: number | null;
  ocr_match_time: string | null;
  ocr_raw_text: string | null;
  ocr_confidence: number;
  verification_confidence: number;
  team_match_result: string;
  fraud_score: number;
  fraud_flags: string | null;
  verification_status: string;
  admin_review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: number | null;
}

export interface FraudLog {
  id: number;
  submission_id: number | null;
  user_id: number;
  match_id: number;
  detection_type: string;
  severity: string;
  details: string | null;
  created_at: string;
}

export interface Notification {
  id: number;
  user_id: number;
  title: string;
  body: string;
  type: string;
  read: number;
  created_at: string;
}

export interface AuthRequest {
  user?: {
    id: number;
    username: string;
    is_admin: number;
    is_super_admin: number;
  };
}
