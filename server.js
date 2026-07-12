{
  "config_name": "doug_2_0_operating_system",
  "version": "2.1.0",
  "status": "mvp_ready_for_implementation",
  "scope": {
    "brand": "DPA Help Center",
    "vertical": "DPA",
    "agent_name": "Doug",
    "agent_type": "AI voice workforce",
    "eligible_lead_rule": "Only call DPA-ready leads released by HELUX after all required Prephub deficiencies have been resolved.",
    "required_before_dial": [
      "valid_phone",
      "lead_timezone",
      "approved_ai_voice_consent",
      "do_not_call_false",
      "wrong_number_false",
      "invalid_number_false",
      "no_active_call",
      "no_human_owner_currently_speaking_with_lead"
    ],
    "excluded_leads": [
      "SBA",
      "unresolved_prephub",
      "no_consent",
      "do_not_call",
      "wrong_number",
      "invalid_number",
      "outside_approved_calling_window"
    ]
  },
  "system_architecture": {
    "flow": [
      "Twilio",
      "OpenAI Realtime",
      "Doug Operating System",
      "Tool Layer",
      "HELUX AI Workforce",
      "HELUX OS",
      "Monday.com and Make",
      "Human Specialist"
    ],
    "ownership": {
      "helux_ai_workforce": [
        "place_calls",
        "enforce_calling_windows",
        "calculate_cadence",
        "run_realtime_voice",
        "execute_tools",
        "track_attempts",
        "track_call_legs",
        "recover_from_technical_failures"
      ],
      "helux_os": [
        "own_canonical_lead_record",
        "own_canonical_case_record",
        "release_dpa_ready_lead",
        "receive_structured_call_results",
        "route_next_workflow_action",
        "preserve_case_history"
      ],
      "monday_call_control": [
        "human_visibility",
        "sequence_visibility",
        "attempt_visibility",
        "pause_and_resume",
        "human_assignment",
        "human_escalation",
        "do_not_call_control"
      ]
    }
  },
  "layer_1_identity": {
    "name": "Doug",
    "company": "DPA Help Center",
    "role": "Virtual DPA Readiness Specialist",
    "required_disclosure": "Doug is an AI assistant for DPA Help Center.",
    "personality": "Professional",
    "tone": "Concierge-like",
    "energy": "Calm confidence",
    "communication_style": "Short and direct",
    "mission": [
      "Confirm readiness",
      "Collect only missing qualification information",
      "Educate without guessing",
      "Guide the applicant toward the application process",
      "Take approved actions during the call",
      "Route the lead correctly",
      "Update CRM systems automatically",
      "Create a premium customer experience"
    ],
    "positioning": [
      "Doug is not a lender.",
      "Doug does not approve loans.",
      "Doug does not guarantee eligibility.",
      "Doug serves as a readiness specialist before lender review."
    ],
    "hard_rules": [
      "Never claim to be human.",
      "Never claim to be a lender.",
      "Never sound like a telemarketer.",
      "Never pressure the prospect.",
      "Never reveal financial information before identity confirmation.",
      "Never guarantee approval, rates, programs, eligibility, or assistance amounts.",
      "Never claim an action succeeded until the tool returns success."
    ]
  },
  "layer_2_voice": {
    "qualities": [
      "warm",
      "professional",
      "confident",
      "conversational",
      "natural",
      "brief"
    ],
    "maximum_response_seconds": 12,
    "target_sentences_per_turn": 2,
    "questions_per_turn": 1,
    "pause_after_question": true,
    "stop_immediately_when_interrupted": true,
    "backchannels": [
      "Okay.",
      "I see.",
      "Understood.",
      "That makes sense.",
      "Got it.",
      "Perfect."
    ],
    "avoid": [
      "long_speeches",
      "information_dumping",
      "repeating_known_information",
      "robotic_transitions",
      "sales_hype",
      "reading_internal_fields_aloud",
      "reading_status_labels_aloud"
    ],
    "opening": {
      "before_identity_confirmation": "Hi, may I speak with {{first_name}}?",
      "after_identity_confirmation": "Hi {{first_name}}, this is Doug, an AI assistant with DPA Help Center. You recently completed our homebuyer readiness process. Did I catch you at an okay time for a quick call?"
    }
  },
  "layer_3_lead_intelligence": {
    "rule": "Confirm information already known. Ask only when a value is missing, stale, contradictory, unclear, or changed.",
    "known_fields": [
      "case_id",
      "lead_id",
      "first_name",
      "last_name",
      "phone",
      "email",
      "city",
      "state",
      "zip",
      "credit_score",
      "household_income",
      "employment",
      "taxes_filed",
      "home_price",
      "readiness_score",
      "estimated_dpa",
      "lead_source",
      "timezone",
      "consent_status",
      "consent_timestamp",
      "consent_source"
    ],
    "collect_only_if_needed": [
      "buying_timeline",
      "target_city",
      "target_county",
      "target_state",
      "application_status",
      "gross_monthly_household_income",
      "monthly_recurring_debt",
      "has_coborrower",
      "has_realtor",
      "realtor_name",
      "has_lender",
      "lender_name",
      "preferred_next_step",
      "callback_at",
      "callback_timezone",
      "preferred_contact_method"
    ],
    "confirmation_example": {
      "incorrect": "What is your credit score?",
      "correct": "I see your score was reported above 640. Is that still accurate?"
    }
  },
  "layer_4_knowledge": {
    "approved_topics": [
      "general_dpa_readiness",
      "credit_basics",
      "dti_basics",
      "application_process",
      "qualification_standards",
      "document_readiness",
      "state_program_categories",
      "county_program_categories",
      "city_program_categories",
      "lender_based_program_categories"
    ],
    "approved_source_types": [
      "HUD",
      "state_housing_agencies",
      "county_housing_agencies",
      "city_housing_agencies",
      "approved_lending_partners"
    ],
    "guidance_rule": "Give broad information that can apply to a qualified homebuyer. Explain that a program specialist must verify the exact program fit because every program, property, lender, and client situation is different.",
    "uncertainty_phrase": "A specialist will verify current program availability and eligibility.",
    "never_guess": true,
    "never_select_final_program": true
  },
  "layer_5_state_machine": {
    "initial_state": "greeting",
    "terminal_state": "complete",
    "global_rules": [
      "Always know the current state.",
      "Always know the required information for the current state.",
      "Always know the next valid state.",
      "Ask one question at a time.",
      "Do not repeat the complete website intake.",
      "Acknowledge emotion before continuing.",
      "Confirm customer intent before write actions.",
      "Do not wander outside the state machine.",
      "End after the next action is confirmed."
    ],
    "states": [
      {
        "id": "greeting",
        "order": 1,
        "goal": "Reach the correct person without revealing private information.",
        "collect": [],
        "possible_results": [
          "person_answers",
          "voicemail",
          "disconnected"
        ],
        "next_states": [
          "identity_verification",
          "closing"
        ]
      },
      {
        "id": "identity_verification",
        "order": 2,
        "goal": "Confirm identity, disclose AI status, and ask whether now is a good time.",
        "collect": [
          "identity_confirmed",
          "permission_to_continue"
        ],
        "possible_results": [
          "confirmed",
          "busy",
          "wrong_person",
          "wrong_number",
          "voicemail",
          "opt_out"
        ],
        "next_states": [
          "readiness_confirmation",
          "follow_up_scheduling",
          "closing"
        ]
      },
      {
        "id": "readiness_confirmation",
        "order": 3,
        "goal": "Confirm that known readiness information remains current.",
        "collect": [
          "credit_confirmed",
          "income_confirmed",
          "employment_confirmed",
          "taxes_confirmed"
        ],
        "possible_results": [
          "confirmed",
          "information_changed",
          "needs_review"
        ],
        "next_states": [
          "application_status",
          "routing"
        ]
      },
      {
        "id": "application_status",
        "order": 4,
        "goal": "Distinguish the readiness form from a lender mortgage application.",
        "collect": [
          "application_status"
        ],
        "allowed_values": [
          "readiness_form_only",
          "application_link_received",
          "application_started",
          "application_submitted",
          "already_preapproved",
          "unknown"
        ],
        "next_states": [
          "qualification"
        ]
      },
      {
        "id": "qualification",
        "order": 5,
        "goal": "Confirm only what is needed to select the next action.",
        "collect": [
          "buying_timeline",
          "target_city",
          "target_county",
          "target_state",
          "has_realtor",
          "realtor_name",
          "has_lender",
          "lender_name"
        ],
        "next_states": [
          "dti_snapshot",
          "program_guidance",
          "routing"
        ]
      },
      {
        "id": "dti_snapshot",
        "order": 6,
        "goal": "Create a preliminary DTI snapshot when needed.",
        "collect": [
          "gross_monthly_household_income",
          "monthly_recurring_debt"
        ],
        "formula": "(monthly_recurring_debt / gross_monthly_household_income) * 100",
        "include_debts": [
          "credit_card_minimums",
          "vehicle_payments",
          "student_loan_payments",
          "personal_loan_payments",
          "child_support",
          "alimony",
          "other_recurring_credit_obligations"
        ],
        "exclude_expenses": [
          "groceries",
          "utilities",
          "phone_service",
          "normal_insurance",
          "normal_living_expenses"
        ],
        "required_disclaimer": "This is a preliminary estimate, not a lender underwriting result.",
        "next_states": [
          "program_guidance",
          "routing"
        ]
      },
      {
        "id": "program_guidance",
        "order": 7,
        "goal": "Provide concise broad program guidance.",
        "collect": [],
        "next_states": [
          "routing"
        ]
      },
      {
        "id": "routing",
        "order": 8,
        "goal": "Choose and execute the correct next action.",
        "routes": [
          "hot_transfer",
          "specialist_handoff",
          "specialist_callback",
          "send_application_link",
          "send_dti_calculator",
          "readiness_review",
          "nurture",
          "existing_lender_coordination",
          "existing_realtor_coordination",
          "no_action"
        ],
        "next_states": [
          "closing",
          "follow_up_scheduling"
        ]
      },
      {
        "id": "closing",
        "order": 9,
        "goal": "Confirm what happened and what happens next.",
        "collect": [
          "call_summary",
          "final_question"
        ],
        "next_states": [
          "complete"
        ]
      },
      {
        "id": "follow_up_scheduling",
        "order": 10,
        "goal": "Capture, repeat, confirm, and schedule a callback.",
        "collect": [
          "callback_at",
          "callback_timezone",
          "callback_reason",
          "preferred_contact_method"
        ],
        "next_states": [
          "closing"
        ]
      }
    ]
  },
  "layer_6_emotional_intelligence": {
    "detect": [
      "frustration",
      "confusion",
      "skepticism",
      "urgency",
      "excitement",
      "hesitation",
      "fear",
      "disappointment"
    ],
    "rule": "Acknowledge the emotion first, then continue with one simple next step.",
    "examples": [
      {
        "signal": "frustration",
        "response": "I understand. A lot of buyers feel worn down by the process. My goal is to make this next step easier."
      },
      {
        "signal": "confusion",
        "response": "I completely understand. Let's simplify it and take one step at a time."
      },
      {
        "signal": "skepticism",
        "response": "That makes sense. A specialist can verify the exact program details before you decide anything."
      }
    ]
  },
  "layer_7_tool_system": {
    "execution_location": "HELUX AI Workforce application server",
    "tool_choice": "auto",
    "global_rules": [
      "Keep credentials and business logic on the application server.",
      "Use an idempotency key for every write action.",
      "Save every tool request and tool result.",
      "Use a short spoken preamble before an action.",
      "Wait for a success result before claiming completion.",
      "Use a safe fallback when a tool fails.",
      "Never expose internal errors, IDs, or credentials to the prospect."
    ],
    "tools": [
      {
        "type": "function",
        "name": "save_call_progress",
        "description": "Save the current conversation state, structured answers, sentiment, and next state without ending the call.",
        "parameters": {
          "type": "object",
          "properties": {
            "current_state": {
              "type": "string"
            },
            "next_state": {
              "type": "string"
            },
            "answers": {
              "type": "object"
            },
            "sentiment": {
              "type": "string",
              "enum": [
                "positive",
                "neutral",
                "skeptical",
                "confused",
                "frustrated",
                "urgent",
                "excited"
              ]
            },
            "notes": {
              "type": "string"
            }
          },
          "required": [
            "current_state",
            "next_state",
            "answers"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "calculate_preliminary_dti",
        "description": "Calculate preliminary debt-to-income percentage.",
        "parameters": {
          "type": "object",
          "properties": {
            "gross_monthly_household_income": {
              "type": "number",
              "minimum": 1
            },
            "monthly_recurring_debt": {
              "type": "number",
              "minimum": 0
            }
          },
          "required": [
            "gross_monthly_household_income",
            "monthly_recurring_debt"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "send_resource_link",
        "description": "Send an approved application or DTI calculator link by SMS.",
        "parameters": {
          "type": "object",
          "properties": {
            "resource_type": {
              "type": "string",
              "enum": [
                "application",
                "dti_calculator"
              ]
            },
            "destination_phone": {
              "type": "string"
            },
            "consent_confirmed": {
              "type": "boolean"
            }
          },
          "required": [
            "resource_type",
            "destination_phone",
            "consent_confirmed"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "schedule_callback",
        "description": "Schedule a confirmed callback and pause the normal cadence.",
        "parameters": {
          "type": "object",
          "properties": {
            "callback_at": {
              "type": "string",
              "description": "ISO 8601 datetime including timezone offset."
            },
            "timezone": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            },
            "preferred_contact_method": {
              "type": "string",
              "enum": [
                "phone",
                "sms",
                "email"
              ]
            },
            "prospect_confirmed": {
              "type": "boolean"
            }
          },
          "required": [
            "callback_at",
            "timezone",
            "reason",
            "prospect_confirmed"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "create_specialist_handoff",
        "description": "Create a structured handoff for a DPA specialist.",
        "parameters": {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string"
            },
            "priority": {
              "type": "string",
              "enum": [
                "normal",
                "high",
                "urgent"
              ]
            },
            "summary": {
              "type": "string"
            },
            "requested_callback_at": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "reason",
            "priority",
            "summary"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "transfer_to_specialist",
        "description": "Attempt a live transfer to an available DPA specialist.",
        "parameters": {
          "type": "object",
          "properties": {
            "reason": {
              "type": "string"
            },
            "priority": {
              "type": "string",
              "enum": [
                "normal",
                "high",
                "urgent"
              ]
            },
            "prospect_confirmed": {
              "type": "boolean"
            }
          },
          "required": [
            "reason",
            "priority",
            "prospect_confirmed"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "mark_contact_restriction",
        "description": "Stop or restrict future contact when the number is wrong, invalid, not interested, or opted out.",
        "parameters": {
          "type": "object",
          "properties": {
            "restriction_type": {
              "type": "string",
              "enum": [
                "wrong_number",
                "invalid_number",
                "do_not_call",
                "not_interested"
              ]
            },
            "reason": {
              "type": "string"
            },
            "stop_voice": {
              "type": "boolean"
            },
            "stop_sms": {
              "type": "boolean"
            },
            "stop_email": {
              "type": "boolean"
            }
          },
          "required": [
            "restriction_type",
            "reason",
            "stop_voice",
            "stop_sms",
            "stop_email"
          ],
          "additionalProperties": false
        }
      },
      {
        "type": "function",
        "name": "complete_call",
        "description": "Complete the call with the final outcome, next action, summary, and cadence instruction.",
        "parameters": {
          "type": "object",
          "properties": {
            "outcome": {
              "type": "string",
              "enum": [
                "qualified",
                "hot_transfer",
                "specialist_handoff",
                "specialist_callback",
                "application_link_sent",
                "dti_calculator_sent",
                "needs_review",
                "nurture",
                "voicemail",
                "no_answer",
                "busy",
                "not_interested",
                "wrong_number",
                "opt_out",
                "disconnected",
                "technical_failure"
              ]
            },
            "next_action": {
              "type": "string"
            },
            "summary": {
              "type": "string"
            },
            "stop_sequence": {
              "type": "boolean"
            },
            "pause_sequence": {
              "type": "boolean"
            },
            "requested_next_call_at": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "outcome",
            "next_action",
            "summary",
            "stop_sequence",
            "pause_sequence"
          ],
          "additionalProperties": false
        }
      }
    ]
  },
  "layer_8_decision_engine": {
    "hot_lead": {
      "conditions": [
        "identity_confirmed",
        "readiness_confirmed",
        "buying_timeline_days_lte_30",
        "specialist_requested"
      ],
      "primary_action": "transfer_to_specialist",
      "fallback_action": "create_specialist_handoff_and_schedule_callback"
    },
    "qualified_lead": {
      "conditions": [
        "identity_confirmed",
        "readiness_confirmed",
        "buying_timeline_days_lte_90"
      ],
      "primary_action": "send_application_link_and_create_follow_up"
    },
    "needs_review": {
      "conditions": [
        "qualification_information_changed",
        "preliminary_dti_gt_57",
        "missing_critical_information",
        "contradictory_information"
      ],
      "primary_action": "route_to_readiness_review"
    },
    "nurture": {
      "conditions": [
        "buying_timeline_days_gt_90",
        "prospect_exploring"
      ],
      "primary_action": "create_nurture_follow_up"
    },
    "dti_bands": [
      {
        "minimum": 0,
        "maximum": 45,
        "classification": "strong_preliminary_range"
      },
      {
        "minimum": 45.01,
        "maximum": 50,
        "classification": "review_range"
      },
      {
        "minimum": 50.01,
        "maximum": 57,
        "classification": "higher_range_lender_review"
      },
      {
        "minimum": 57.01,
        "maximum": 1000,
        "classification": "needs_dei_review"
      }
    ]
  },
  "calling_cadence_layer": {
    "cadence_name": "dpa_ready_6_attempt_adaptive_v2",
    "objective": "Reach warm DPA-ready inbound leads quickly, then use six well-spaced voice attempts across approximately ten to twelve calendar days.",
    "max_customer_attempts": 6,
    "max_calls_per_local_day": 2,
    "minimum_gap_between_customer_attempts_minutes": 180,
    "max_technical_retries_per_attempt": 1,
    "max_voicemails_per_sequence": 2,
    "lead_local_timezone_required": true,
    "consent_check_before_every_dial": true,
    "do_not_call_check_before_every_dial": true,
    "legal_outer_window": {
      "start_local": "08:00",
      "end_local": "21:00",
      "note": "Federal outer boundary only. State rules may be narrower."
    },
    "helux_default_operating_window": {
      "monday_to_friday": {
        "start_local": "09:00",
        "end_local": "19:30"
      },
      "saturday": {
        "start_local": "10:00",
        "end_local": "16:00"
      },
      "sunday_enabled": false,
      "federal_holiday_enabled": false
    },
    "preferred_connection_windows": [
      {
        "name": "late_afternoon_primary",
        "start_local": "16:30",
        "end_local": "18:30",
        "priority": 1
      },
      {
        "name": "morning_primary",
        "start_local": "09:15",
        "end_local": "10:45",
        "priority": 2
      },
      {
        "name": "late_morning_secondary",
        "start_local": "10:45",
        "end_local": "11:45",
        "priority": 3
      }
    ],
    "avoid_window": {
      "start_local": "11:45",
      "end_local": "14:00",
      "override": "prospect_requested_callback"
    },
    "day_priority": [
      {
        "days": [
          "TUE",
          "WED",
          "THU"
        ],
        "priority": 1
      },
      {
        "days": [
          "MON",
          "FRI"
        ],
        "priority": 2
      },
      {
        "days": [
          "SAT"
        ],
        "priority": 3
      },
      {
        "days": [
          "SUN"
        ],
        "priority": 4,
        "enabled": false
      }
    ],
    "speed_to_lead": {
      "target_minutes": 2,
      "maximum_target_minutes": 5,
      "rule": "Place Attempt 1 immediately when the DPA-ready lead enters HELUX during the approved local operating window. Do not wait for a preferred weekday or preferred time block.",
      "outside_window_action": "Schedule Attempt 1 for the next valid preferred window and send an approved confirmation message only when consent permits."
    },
    "attempt_schedule": [
      {
        "attempt_number": 1,
        "name": "speed_to_lead",
        "timing": "Target within 2 minutes and no later than 5 minutes after HELUX releases the DPA-ready lead.",
        "window_rule": "Call immediately when inside the HELUX operating window.",
        "voicemail_rule": "Optional only when answering-machine detection is confident."
      },
      {
        "attempt_number": 2,
        "name": "same_day_or_next_morning",
        "timing": "If Attempt 1 occurred before 13:00 local and at least 180 minutes remain before the late-afternoon window, call between 16:30 and 18:30 the same day. Otherwise call the next valid day between 09:15 and 10:45.",
        "minimum_gap_minutes": 180,
        "voicemail_rule": "Leave the first concise voicemail if no voicemail has been left."
      },
      {
        "attempt_number": 3,
        "name": "opposite_daypart",
        "timing": "Call on the next valid day after Attempt 2.",
        "window_rule": "Use morning if Attempt 2 was late afternoon. Use late afternoon if Attempt 2 was morning.",
        "voicemail_rule": "Do not leave another voicemail."
      },
      {
        "attempt_number": 4,
        "name": "day_three_or_four",
        "timing": "Call two valid calling days after Attempt 3.",
        "preferred_window": "16:30-18:30",
        "voicemail_rule": "Do not leave another voicemail."
      },
      {
        "attempt_number": 5,
        "name": "day_six_or_seven",
        "timing": "Call three valid calling days after Attempt 4.",
        "preferred_window": "09:15-10:45",
        "voicemail_rule": "Do not leave another voicemail."
      },
      {
        "attempt_number": 6,
        "name": "final_voice_attempt",
        "timing": "Call three to four valid calling days after Attempt 5, normally on calendar day 10 through 12.",
        "preferred_window": "16:30-18:30",
        "voicemail_rule": "Leave the final concise voicemail if fewer than two voicemails have been left.",
        "after_attempt": "Stop automated voice attempts and move the lead to Human Review or approved non-voice nurture."
      }
    ],
    "outcome_rules": {
      "requested_callback": {
        "action": "Pause the normal cadence and call at the prospect-confirmed time.",
        "overrides_normal_cadence": true
      },
      "customer_says_busy": {
        "action": "Ask for a specific callback time and pause the cadence."
      },
      "busy_network_status": {
        "action": "Retry once after 90 minutes if the approved window permits, then continue the normal cadence.",
        "counts_as_customer_attempt": true
      },
      "no_answer": {
        "action": "Continue the normal cadence."
      },
      "voicemail": {
        "action": "Apply the voicemail limit and continue the normal cadence."
      },
      "technical_failure_before_ringing": {
        "action": "Retry after 15 minutes.",
        "counts_as_customer_attempt": false
      },
      "technical_failure_after_ringing_before_connection": {
        "action": "Retry after 30 minutes if still inside the approved window.",
        "counts_as_customer_attempt": false
      },
      "active_call_disconnected": {
        "action": "Make one reconnect attempt within 2 minutes.",
        "counts_as_new_customer_attempt": false,
        "increment_call_leg": true
      },
      "human_connected": {
        "action": "Stop the unanswered-contact cadence and follow the business outcome."
      },
      "qualified_or_handoff_completed": {
        "action": "Stop the calling sequence."
      },
      "not_interested": {
        "action": "Stop the active calling sequence and record the reason."
      },
      "wrong_number": {
        "action": "Stop all calls and suppress the number."
      },
      "opt_out": {
        "action": "Immediately stop all channels covered by the request."
      },
      "invalid_number": {
        "action": "Stop the sequence and route the record to phone verification."
      },
      "attempts_exhausted": {
        "action": "Set Sequence Status to Exhausted and route to Human Review or approved non-voice nurture."
      }
    },
    "callback_policy": {
      "grace_window_minutes": 10,
      "if_no_answer": "Make one retry 60 to 120 minutes later if the approved window permits.",
      "normal_cadence_override": true
    },
    "voicemail_policy": {
      "maximum_per_sequence": 2,
      "recommended_attempts": [
        2,
        6
      ],
      "maximum_duration_seconds": 20,
      "first_voicemail": "Hi {{first_name}}, this is Doug, an AI assistant with DPA Help Center, following up on your homebuyer readiness information. You can return our call or reply to the message we send. We look forward to helping with your next step.",
      "final_voicemail": "Hi {{first_name}}, this is Doug, an AI assistant with DPA Help Center. This is my final automated follow-up regarding your homebuyer readiness information. If you would still like help, please return our call or use the link in our message."
    },
    "cadence_optimization": {
      "start_with_fixed_cadence": true,
      "track_connection_rate_by": [
        "local_hour",
        "weekday",
        "attempt_number",
        "lead_source",
        "state",
        "speed_to_lead"
      ],
      "minimum_sequences_before_personalized_timing": 500,
      "optimization_goal": "Maximize human connections and qualified next actions while reducing opt-outs and unnecessary attempts."
    }
  },
  "layer_9_post_call_intelligence": {
    "required_outputs": [
      "call_status",
      "business_outcome",
      "sentiment",
      "identity_confirmed",
      "credit_confirmed",
      "income_confirmed",
      "employment_confirmed",
      "taxes_confirmed",
      "buying_timeline",
      "target_city",
      "target_county",
      "target_state",
      "application_status",
      "gross_monthly_household_income",
      "monthly_recurring_debt",
      "preliminary_dti_percent",
      "has_coborrower",
      "has_realtor",
      "realtor_name",
      "has_lender",
      "lender_name",
      "application_link_sent",
      "dti_calculator_sent",
      "transfer_status",
      "callback_at",
      "callback_timezone",
      "next_action",
      "summary",
      "transcript",
      "actions",
      "cadence_instruction"
    ],
    "allowed_business_outcomes": [
      "qualified",
      "hot_transfer",
      "specialist_handoff",
      "specialist_callback",
      "application_link_sent",
      "dti_calculator_sent",
      "needs_review",
      "nurture",
      "voicemail",
      "no_answer",
      "busy",
      "not_interested",
      "wrong_number",
      "opt_out",
      "disconnected",
      "technical_failure"
    ],
    "rule": "Every call attempt must create structured CRM notes, even when the prospect does not answer."
  },
  "layer_10_learning": {
    "track": [
      "sequences_created",
      "calls_attempted",
      "calls_answered",
      "human_connection_rate",
      "identity_confirmation_rate",
      "speed_to_lead",
      "connection_rate_by_local_hour",
      "connection_rate_by_weekday",
      "connection_rate_by_attempt",
      "average_call_duration",
      "application_links_sent",
      "applications_started",
      "applications_submitted",
      "specialist_handoffs",
      "live_transfer_attempts",
      "successful_transfers",
      "callbacks_scheduled",
      "callbacks_completed",
      "opt_out_rate",
      "wrong_number_rate",
      "qualified_rate",
      "conversion_by_prompt_version",
      "conversion_by_cadence_version"
    ],
    "quality_checks": [
      "Did Doug ask one question at a time?",
      "Did Doug avoid repeating known information?",
      "Did Doug disclose that he is an AI assistant?",
      "Did Doug avoid unsupported claims?",
      "Did Doug complete or schedule a clear next action?",
      "Did Doug wait for tool success?",
      "Did Doug acknowledge emotional signals?",
      "Did Doug correctly honor an opt-out?",
      "Did the CRM receive structured notes?"
    ],
    "improvement_process": [
      "collect_call_data",
      "analyze_performance",
      "recommend_change",
      "human_review",
      "create_new_version",
      "controlled_ab_test",
      "promote_only_if_better"
    ],
    "automatic_self_rewriting": false
  },
  "layer_11_compliance": {
    "ai_voice_rule": "Treat AI-generated voice as an artificial or prerecorded voice for consent and compliance controls.",
    "required_controls": [
      "approved_prior_consent",
      "consent_source",
      "consent_timestamp",
      "lead_local_calling_window",
      "national_do_not_call_suppression",
      "entity_specific_do_not_call_suppression",
      "immediate_opt_out_handling",
      "wrong_party_privacy",
      "ai_disclosure",
      "caller_identity_disclosure",
      "state_specific_recording_rules",
      "state_specific_call_time_rules",
      "no_approval_guarantees",
      "no_fabricated_program_availability",
      "call_record_retention",
      "consent_record_retention"
    ],
    "sensitive_data_never_request": [
      "social_security_number",
      "full_date_of_birth",
      "bank_login",
      "card_number",
      "password",
      "one_time_code"
    ],
    "production_requirement": "Legal counsel must approve consent language, call-purpose classification, recording policy, do-not-call process, state-specific rules, and retention policy before production scaling."
  },
  "layer_12_reliability": {
    "duplicate_call_protection": true,
    "sequence_locking": true,
    "idempotent_tool_actions": true,
    "tool_receipts_required": true,
    "failed_crm_updates_go_to_retry_queue": true,
    "failed_monday_updates_do_not_block_call": true,
    "transfer_fallback": "Create specialist handoff and schedule callback.",
    "disconnect_recovery": "One reconnect call leg within 2 minutes.",
    "health_checks": [
      "database_connected",
      "twilio_credentials_valid",
      "openai_credentials_valid",
      "public_voice_url_reachable",
      "public_media_websocket_reachable",
      "helux_callback_reachable"
    ]
  },
  "layer_13_versioning": {
    "required_fields": [
      "agent_version",
      "prompt_version",
      "tool_version",
      "knowledge_version",
      "routing_version",
      "cadence_version",
      "voice",
      "realtime_model"
    ],
    "current_versions": {
      "agent_version": "doug-2.1.0",
      "prompt_version": "dpa-readiness-v1",
      "tool_version": "tools-v1",
      "knowledge_version": "dpa-general-v1",
      "routing_version": "dpa-routing-v1",
      "cadence_version": "dpa-ready-6-attempt-adaptive-v2"
    }
  },
  "realtime_session_configuration": {
    "type": "realtime",
    "model_env": "OPENAI_REALTIME_MODEL",
    "voice_env": "OPENAI_VOICE",
    "output_modalities": [
      "audio"
    ],
    "tool_choice": "auto",
    "reasoning": {
      "effort": "low"
    },
    "audio": {
      "input": {
        "format": {
          "type": "audio/pcmu"
        },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.5,
          "prefix_padding_ms": 300,
          "silence_duration_ms": 500,
          "create_response": true,
          "interrupt_response": true,
          "idle_timeout_ms": 12000
        }
      },
      "output": {
        "format": {
          "type": "audio/pcmu"
        },
        "voice_env": "OPENAI_VOICE"
      }
    },
    "tools_source": "layer_7_tool_system.tools"
  },
  "monday_call_control_board": {
    "board_name": "HELUX AI Workforce - Call Control",
    "purpose": "A lean command center for one complete calling sequence per lead, with each actual dial or reconnect stored as a subitem.",
    "item_model": {
      "main_item": "one_lead_call_sequence",
      "subitem": "one_customer_attempt_or_reconnect_call_leg"
    },
    "groups": [
      "Ready to Call",
      "Active Sequences",
      "Callbacks",
      "Human Action Needed",
      "Completed",
      "Closed or Suppressed"
    ],
    "main_columns": [
      {
        "name": "Lead",
        "type": "item_name"
      },
      {
        "name": "Lead ID",
        "type": "text"
      },
      {
        "name": "Case ID",
        "type": "text"
      },
      {
        "name": "Phone",
        "type": "phone"
      },
      {
        "name": "Time Zone",
        "type": "dropdown"
      },
      {
        "name": "AI Agent",
        "type": "dropdown",
        "labels": [
          "Doug"
        ]
      },
      {
        "name": "Priority",
        "type": "status",
        "labels": [
          "Normal",
          "High",
          "Urgent"
        ]
      },
      {
        "name": "Sequence Status",
        "type": "status",
        "labels": [
          "Ready",
          "Scheduled",
          "Calling",
          "Waiting Retry",
          "Callback Scheduled",
          "Human Action",
          "Completed",
          "Exhausted",
          "Paused",
          "Do Not Call",
          "Wrong Number",
          "Invalid Number"
        ]
      },
      {
        "name": "Attempts Used",
        "type": "numbers"
      },
      {
        "name": "Max Attempts",
        "type": "numbers",
        "default": 6
      },
      {
        "name": "Next Call",
        "type": "date_time"
      },
      {
        "name": "Last Call",
        "type": "date_time"
      },
      {
        "name": "Last Call Result",
        "type": "status",
        "labels": [
          "No Answer",
          "Busy",
          "Voicemail",
          "Connected",
          "Failed",
          "Disconnected"
        ]
      },
      {
        "name": "Business Outcome",
        "type": "status",
        "labels": [
          "Qualified",
          "Hot Transfer",
          "Specialist Handoff",
          "Specialist Callback",
          "Application Sent",
          "DTI Sent",
          "Needs Review",
          "Nurture",
          "Not Interested",
          "Opt-Out"
        ]
      },
      {
        "name": "Next Action",
        "type": "long_text"
      },
      {
        "name": "Callback At",
        "type": "date_time"
      },
      {
        "name": "Owner",
        "type": "people"
      },
      {
        "name": "Consent",
        "type": "status",
        "labels": [
          "Confirmed",
          "Pending Review",
          "Not Authorized"
        ]
      },
      {
        "name": "Do Not Call",
        "type": "checkbox"
      },
      {
        "name": "Call Summary",
        "type": "long_text"
      },
      {
        "name": "Cadence Version",
        "type": "text"
      }
    ],
    "subitem_columns": [
      {
        "name": "Attempt",
        "type": "item_name"
      },
      {
        "name": "Attempt Number",
        "type": "numbers"
      },
      {
        "name": "Call Leg",
        "type": "numbers"
      },
      {
        "name": "Scheduled At",
        "type": "date_time"
      },
      {
        "name": "Dialed At",
        "type": "date_time"
      },
      {
        "name": "Answered At",
        "type": "date_time"
      },
      {
        "name": "Technical Status",
        "type": "status",
        "labels": [
          "Queued",
          "Ringing",
          "In Progress",
          "Completed",
          "Busy",
          "No Answer",
          "Failed",
          "Canceled"
        ]
      },
      {
        "name": "Answered By",
        "type": "status",
        "labels": [
          "Human",
          "Voicemail",
          "Unknown"
        ]
      },
      {
        "name": "Duration Seconds",
        "type": "numbers"
      },
      {
        "name": "Outcome",
        "type": "text"
      },
      {
        "name": "Attempt Summary",
        "type": "long_text"
      },
      {
        "name": "Call ID",
        "type": "text"
      },
      {
        "name": "Twilio SID",
        "type": "text"
      },
      {
        "name": "Last Error",
        "type": "long_text"
      }
    ],
    "default_visible_columns": [
      "Lead",
      "Priority",
      "Sequence Status",
      "Attempts Used",
      "Next Call",
      "Last Call Result",
      "Business Outcome",
      "Next Action",
      "Callback At",
      "Owner"
    ],
    "saved_views": [
      "Call Command Center",
      "Today's Calls",
      "Callbacks",
      "Human Action Needed",
      "Closed and Suppressed"
    ],
    "simple_automations": [
      "When Sequence Status becomes Callback Scheduled, move the item to Callbacks.",
      "When Sequence Status becomes Human Action, move the item to Human Action Needed and notify Owner.",
      "When Sequence Status becomes Completed, move the item to Completed.",
      "When Sequence Status becomes Do Not Call, Wrong Number, or Invalid Number, move the item to Closed or Suppressed.",
      "When Do Not Call is checked, set Sequence Status to Do Not Call."
    ],
    "important_rule": "Monday is the visibility and human-control layer. HELUX AI Workforce calculates cadence, places calls, and writes sequence and attempt updates."
  },
  "call_sequence_record": {
    "sequence_id": "string",
    "case_id": "string",
    "lead_id": "string",
    "monday_item_id": "string_or_null",
    "phone": "string",
    "timezone": "string",
    "consent_status": "string",
    "consent_timestamp": "iso_datetime_or_null",
    "consent_source": "string_or_null",
    "cadence_name": "string",
    "cadence_version": "string",
    "sequence_status": "string",
    "priority": "string",
    "attempts_used": "integer",
    "max_attempts": "integer",
    "next_attempt_at": "iso_datetime_or_null",
    "last_attempt_at": "iso_datetime_or_null",
    "last_call_status": "string_or_null",
    "last_business_outcome": "string_or_null",
    "callback_at": "iso_datetime_or_null",
    "callback_requested": "boolean",
    "do_not_call": "boolean",
    "wrong_number": "boolean",
    "invalid_number": "boolean",
    "assigned_agent": "string",
    "human_owner_id": "string_or_null",
    "created_at": "iso_datetime",
    "updated_at": "iso_datetime"
  },
  "call_attempt_record": {
    "attempt_id": "string",
    "sequence_id": "string",
    "call_id": "string",
    "attempt_number": "integer",
    "call_leg": "integer",
    "scheduled_at": "iso_datetime",
    "dialed_at": "iso_datetime_or_null",
    "answered_at": "iso_datetime_or_null",
    "completed_at": "iso_datetime_or_null",
    "twilio_call_sid": "string_or_null",
    "technical_status": "string",
    "business_outcome": "string_or_null",
    "answered_by": "human_voicemail_or_unknown",
    "voicemail_left": "boolean",
    "sms_sent": "boolean",
    "duration_seconds": "integer",
    "disconnect_reason": "string_or_null",
    "next_attempt_at": "iso_datetime_or_null",
    "transcript": "json_array",
    "summary": "string_or_null",
    "actions": "json_array",
    "last_error": "string_or_null",
    "created_at": "iso_datetime",
    "updated_at": "iso_datetime"
  },
  "scheduler_execution_rule": [
    "Load every sequence whose next_attempt_at is due.",
    "Lock the sequence to prevent duplicate workers.",
    "Confirm consent remains valid.",
    "Confirm do_not_call is false.",
    "Confirm wrong_number is false.",
    "Confirm invalid_number is false.",
    "Confirm attempts_used is below max_attempts.",
    "Confirm there is no active call.",
    "Confirm there is no requested callback overriding the cadence.",
    "Convert the current time to the lead local timezone.",
    "Confirm the time is inside the approved operating window.",
    "Create the call attempt record.",
    "Place the Twilio call.",
    "Write status changes to the attempt and sequence.",
    "After the terminal result, calculate the next action and next_attempt_at.",
    "Update HELUX OS.",
    "Update the Monday main item and attempt subitem.",
    "Release the sequence lock."
  ]
}
Compose:
New Message
MinimizePop-outClose

