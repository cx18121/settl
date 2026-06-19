export type Cents = number;

export interface ShareInput {
  memberId: string;
  amountCents: Cents;
}

export interface NetPosition {
  memberId: string;
  cents: Cents; // positive = is owed money, negative = owes money
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
}
