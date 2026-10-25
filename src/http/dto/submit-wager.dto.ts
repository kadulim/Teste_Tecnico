import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class WagerMoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWagerDto {
  @IsString()
  @Length(1, 160)
  providerId!: string;

  @IsString()
  @Length(1, 200)
  externalTransactionId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 160)
  playerId!: string;

  @IsString()
  @Length(1, 200)
  roundId!: string;

  @IsString()
  @Length(1, 200)
  gameId!: string;

  @IsOptional()
  @IsString()
  @IsIn(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"])
  kind?: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

  @IsOptional()
  @IsString()
  @IsIn(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"])
  type?: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

  @IsOptional()
  @ValidateNested()
  @Type(() => WagerMoneyDto)
  money?: WagerMoneyDto;

  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  referenceExternalTransactionId?: string;
}
