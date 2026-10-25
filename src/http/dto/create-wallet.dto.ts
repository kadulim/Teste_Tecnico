import { IsOptional, IsString, Length, Matches, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})\.\d{2}$/)
  amount!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}

export class CreateWalletDto {
  @IsString()
  @Length(1, 160)
  playerId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string = "BRL";

  @IsOptional()
  initialBalance?: string | MoneyDto;
}
